/**
 * @fileoverview SDK API Routes
 * @module routes/sdk
 * 
 * Production-grade API routes for the Consonant SDK.
 * Implements agent registration and execution with:
 * - Parallel DB and Inngest operations for performance
 * - Proper error handling and retries
 * - Organization-scoped multi-tenancy
 */

import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getAgentRegistry } from '../services/agent.service.js';
import { inngest } from '../services/inngest/client.js';
import { logger } from '../utils/logger.js';
import { prismaManager } from '../services/db/manager.js';
import { AgentStatus, ExecutionStatus } from '@prisma/client';


// =============================================================================
// VALIDATION SCHEMAS
// =============================================================================

const AgentRegistrationSchema = z.object({
    name: z.string()
        .min(1, 'Agent name is required')
        .max(100, 'Agent name must be 100 characters or less')
        .regex(/^[a-z0-9-]+$/, 'Agent name must contain only lowercase letters, numbers, and hyphens'),
    image: z.string()
        .min(1, 'Docker image is required')
        .regex(/^.+\/.+:.+$/, 'Image must be a valid Docker image URL (e.g., docker.io/company/image:tag)'),
    description: z.string().optional(),
    resources: z.object({
        cpu: z.string(),
        memory: z.string(),
        gpu: z.string().optional(),
        timeout: z.string(),
    }),
    retryPolicy: z.object({
        maxAttempts: z.number().min(1).max(10),
        backoff: z.enum(['exponential', 'linear', 'constant']),
        initialDelay: z.string().optional(),
    }),
    useAgentSandbox: z.boolean().optional(),
    warmPoolSize: z.number().min(0).max(100).optional(),
    networkPolicy: z.enum(['restricted', 'standard', 'unrestricted']).optional(),
    environmentVariables: z.record(z.string(), z.string()).optional(),
});

const ExecutionRequestSchema = z.object({
    agent: z.string().min(1, 'Agent name or ID is required'),
    input: z.record(z.string(), z.unknown()),
    priority: z.enum(['high', 'normal', 'low']).optional().default('normal'),
    cluster: z.string().optional(),
});

// =============================================================================
// ROUTE REGISTRATION
// =============================================================================

export async function registerApiRoutes(fastify: FastifyInstance) {

    // =========================================================================
    // POST /api/agents - Register Agent (ASYNC)
    // =========================================================================
    fastify.post<{
        Body: z.infer<typeof AgentRegistrationSchema>;
    }>('/api/agents/register', async (request, reply) => {
        const organizationId = (request as any).organizationId;
        const config = request.body;

        if (!organizationId) {
            return reply.code(401).send({
                error: 'Unauthorized',
                message: 'Valid API key required',
            });
        }

        try {
            // Generate a request ID for tracing
            const requestId = crypto.randomUUID();

            // Trigger Async Registration Workflow
            // DB Upsert + Event Emission will happen inside Inngest
            await inngest.send({
                name: 'agent.registration.requested',
                data: {
                    organizationId,
                    config,
                    requestId,
                    requestedAt: new Date().toISOString(),
                },
            });

            logger.info({
                organizationId,
                agentName: config.name,
                requestId,
            }, 'Agent registration queued (Async)');

            // Return 202 Accepted
            return reply.code(202).send({
                accepted: true,
                message: 'Registration queued',
                requestId,
            });
        } catch (error: any) {
            logger.error({ error, config }, 'Failed to queue registration');

            return reply.code(500).send({
                error: 'Internal server error',
                message: 'Failed to queue registration',
            });
        }
    });

    // =========================================================================
    // GET /api/agents - List/Find Agents
    // =========================================================================
    fastify.get<{
        Querystring: { name?: string };
    }>('/api/agents', async (request, reply) => {
        const organizationId = (request as any).organizationId;
        const { name } = request.query;

        if (!organizationId) {
            return reply.code(401).send({ error: 'Unauthorized' });
        }

        try {
            const agentRegistry = getAgentRegistry();

            if (name) {
                const agent = await agentRegistry.get(organizationId, name);
                return { agents: agent ? [agent] : [] };
            }

            const agents = await agentRegistry.list(organizationId);
            return { agents };
        } catch (error) {
            logger.error({ error, organizationId }, 'Failed to list agents');
            return reply.code(500).send({ error: 'Internal server error' });
        }
    });

    // =========================================================================
    // POST /api/executions - Execute Agent (ASYNC)
    // =========================================================================
    fastify.post<{
        Body: z.infer<typeof ExecutionRequestSchema>;
    }>('/api/execute', async (request, reply) => {
        const parseResult = ExecutionRequestSchema.safeParse(request.body);

        if (!parseResult.success) {
            return reply.code(400).send({
                error: 'Validation failed',
                details: parseResult.error.format(),
            });
        }

        const { agent: agentName, input } = parseResult.data;
        const organizationId = (request as any).organizationId;

        if (!organizationId) {
            return reply.code(401).send({ error: 'Unauthorized' });
        }

        try {
            // 1. Verify Agent Exists (fast lookup)
            const agentRegistry = getAgentRegistry();
            const agent = await agentRegistry.get(organizationId, agentName);

            if (!agent) {
                return reply.code(404).send({
                    error: 'Agent not found',
                    message: `Agent '${agentName}' does not exist in this organization`,
                });
            }

            if (agent.status !== AgentStatus.ACTIVE) {
                return reply.code(400).send({
                    error: 'Agent not ready',
                    message: `Agent '${agentName}' is not in active state (current: ${agent.status})`,
                });
            }

            // 2. Generate ID
            const executionId = crypto.randomUUID();
            const prisma = await prismaManager.getClient();

            // 3. Parallel Persistence & Queueing
            // We create the DB record synchronously here so the client can poll immediately without 404s
            // We use Promise.all to maximize concurrency
            await Promise.all([
                // A. Create Pending Execution Record
                prisma.execution.create({
                    data: {
                        id: executionId,
                        agentId: agent.id,
                        status: 'PENDING',
                        input: input as any || {},
                        priority: 'NORMAL',
                        maxAttempts: (agent.retryPolicy as any)?.maxAttempts || 3,
                    }
                }),

                // B. Trigger Async Workflow (Queueing to Redis, Cluster Selection etc.)
                inngest.send({
                    name: 'agent.execution.requested',
                    data: {
                        executionId,
                        agentId: agent.id, // Use resolved ID
                        organizationId,
                        input: input || {},
                        priority: 'normal',
                        requestedAt: new Date().toISOString(),
                    },
                })
            ]);

            logger.info({
                executionId,
                agentName,
                organizationId,
            }, 'Execution created and queued (Parallel)');

            return reply.code(202).send({
                executionId: executionId, // Consistent naming
                status: 'pending',
                message: 'Execution initiated',
            });

        } catch (error: any) {
            logger.error({ error, agentName }, 'Failed to queue execution');
            return reply.code(500).send({
                error: 'Internal server error',
                message: 'Failed to queue execution',
            });
        }
    });


    // =========================================================================
    // GET /api/executions/:executionId - Get Execution Status
    // =========================================================================
    fastify.get<{
        Params: { executionId: string };
    }>('/api/executions/:executionId', async (request, reply) => {
        const organizationId = (request as any).organizationId;
        if (!organizationId) {
            return reply.code(401).send({
                error: 'Unauthorized',
                message: 'Valid API key required',
            });
        }

        const { executionId } = request.params;

        try {
            const prisma = await prismaManager.getClient();

            // Fetch execution with agent for ownership verification
            const execution = await prisma.execution.findUnique({
                where: { id: executionId },
                include: {
                    agent: {
                        select: {
                            organizationId: true,
                        },
                    },
                },
            });

            if (!execution) {
                return reply.code(404).send({
                    error: 'Not found',
                    message: 'Execution not found',
                });
            }

            // Verify ownership via agent's organization
            if (execution.agent.organizationId !== organizationId) {
                return reply.code(403).send({
                    error: 'Forbidden',
                    message: 'Access denied to this execution',
                });
            }

            // Build response
            const response: any = {
                executionId: execution.id,
                status: execution.status,
                createdAt: execution.createdAt.toISOString(),
            };

            if (execution.queuedAt) {
                response.queuedAt = execution.queuedAt.toISOString();
            }
            if (execution.startedAt) {
                response.startedAt = execution.startedAt.toISOString();
            }
            if (execution.completedAt) {
                response.completedAt = execution.completedAt.toISOString();
            }
            if (execution.durationMs) {
                response.durationMs = execution.durationMs;
            }

            if (execution.status === ExecutionStatus.COMPLETED && execution.result) {
                response.result = execution.result;
                response.resourceUsage = execution.resourceUsage || {
                    cpuSeconds: 0,
                    memoryMbSeconds: 0,
                };
            }

            if (execution.status === ExecutionStatus.FAILED && execution.error) {
                response.error = {
                    message: execution.error,
                    code: 'execution_failed',
                };
            }

            return reply.send(response);
        } catch (error) {
            logger.error({ error, executionId }, 'Failed to get execution status');
            return reply.code(500).send({
                error: 'Internal server error',
                message: 'Failed to get execution status',
            });
        }
    });

    logger.info('SDK API routes registered');
}