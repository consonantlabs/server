/**
 * @fileoverview Fastify API Routes
 * @module routes/api
 * 
 * This module defines the HTTP API that SDK clients use to interact with
 * the control plane. The API has two main operations:
 * 
 * 1. POST /agents - Register a new agent
 * 2. POST /executions - Execute an agent
 * 
 * AUTHENTICATION:
 * All routes require API key authentication via the X-API-Key header.
 * The middleware validates the key and injects the apiKeyId into the request.
 * 
 * ARCHITECTURAL PATTERN:
 * Routes are thin - they validate input, authenticate, and trigger events.
 * The actual orchestration happens in Inngest functions. This keeps routes
 * fast and makes the system resilient (Inngest handles retries and durability).
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { getAgentRegistry } from '../services/agent-registry.js';
import { inngest } from '../services/inngest/client.js';
import { logger } from '../utils/logger.js';
import { prismaManager } from '../services/db/manager.js';
import type { AgentConfig } from '../services/inngest/events.js';

/**
 * Zod schema for agent registration request.
 * Provides runtime validation with helpful error messages.
 */
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

/**
 * Zod schema for execution request.
 */
const ExecutionRequestSchema = z.object({
    agent: z.string().min(1, 'Agent name or ID is required'),
    input: z.record(z.string(), z.unknown()),
    priority: z.enum(['high', 'normal', 'low']).optional().default('normal'),
    cluster: z.string().optional(), // Optional: specific cluster to use
});

/**
 * Register API routes with the Fastify instance.
 * 
 * @param fastify - Fastify instance
 */
export async function registerApiRoutes(fastify: FastifyInstance) {
    /**
     * POST /api/agents - Register a new agent
     * 
     * Creates an agent definition that can be executed multiple times.
     * Agent names must be unique within the customer's namespace.
     * 
     * Request body: AgentConfig (validated by Zod)
     * Response: { id, name, status, createdAt }
     */
    fastify.post<{
        Body: z.infer<typeof AgentRegistrationSchema>;
    }>('/api/agents', async (request: FastifyRequest, reply: FastifyReply) => {
        // Parse and validate request body
        const parseResult = AgentRegistrationSchema.safeParse(request.body);

        if (!parseResult.success) {
            return reply.code(400).send({
                error: 'Validation failed',
                details: parseResult.error.format(),
            });
        }

        const config = parseResult.data as AgentConfig;

        // Get API key ID from authentication middleware
        const apiKeyId = request.apiKeyId;
        if (!apiKeyId) {
            return reply.code(401).send({
                error: 'Unauthorized',
                message: 'Valid API key required',
            });
        }

        try {
            const agentRegistry = getAgentRegistry();
            const agent = await agentRegistry.register(apiKeyId, config);

            // Emit agent registered event
            await inngest.send({
                name: 'agent.registered',
                data: {
                    agentId: agent.id,
                    apiKeyId: agent.apiKeyId,
                    config: config,
                    createdAt: agent.createdAt.toISOString(),
                },
            });

            logger.info({
                agentId: agent.id,
                agentName: agent.name,
            }, 'Agent registered via API');

            return reply.code(201).send({
                id: agent.id,
                name: agent.name,
                status: 'registered',
                createdAt: agent.createdAt.toISOString(),
            });
        } catch (error: any) {
            logger.error({ error, config }, 'Failed to register agent');

            if (error.message.includes('already exists')) {
                return reply.code(409).send({
                    error: 'Conflict',
                    message: error.message,
                });
            }

            return reply.code(500).send({
                error: 'Internal server error',
                message: 'Failed to register agent',
            });
        }
    });

    /**
     * POST /api/executions - Execute an agent
     * 
     * This is the main entry point for running agents. The request triggers
     * an Inngest workflow that orchestrates the complete execution lifecycle.
     * 
     * The response is returned immediately with status 202 (Accepted) and an
     * execution ID. However, in practice, the SDK will wait for the actual
     * result using Inngest's durable execution mechanism.
     * 
     * Request body: { agent, input, priority?, cluster? }
     * Response: { executionId, status: 'pending' }
     */
    fastify.post<{
        Body: z.infer<typeof ExecutionRequestSchema>;
    }>('/api/executions', async (request: FastifyRequest, reply: FastifyReply) => {
        // Parse and validate request body
        const parseResult = ExecutionRequestSchema.safeParse(request.body);

        if (!parseResult.success) {
            return reply.code(400).send({
                error: 'Validation failed',
                details: parseResult.error.format(),
            });
        }

        const { agent: agentNameOrId, input, priority, cluster } = parseResult.data;

        // Get API key ID from authentication middleware
        const apiKeyId = request.apiKeyId;
        if (!apiKeyId) {
            return reply.code(401).send({
                error: 'Unauthorized',
                message: 'Valid API key required',
            });
        }

        try {
            // Look up the agent
            const agentRegistry = getAgentRegistry();
            const agent = await agentRegistry.get(apiKeyId, agentNameOrId);

            if (!agent) {
                return reply.code(404).send({
                    error: 'Not found',
                    message: `Agent "${agentNameOrId}" not found`,
                });
            }

            // Generate execution ID
            const executionId = `exec_${Date.now()}_${Math.random().toString(36).substring(7)}`;

            // Trigger the execution workflow via Inngest
            // This is non-blocking - the workflow runs asynchronously
            await inngest.send({
                name: 'agent.execution.requested',
                data: {
                    executionId,
                    agentId: agent.id,
                    apiKeyId: apiKeyId as string,
                    input: input as any,
                    priority: (priority as any) || 'normal',
                    cluster: cluster as string,
                    requestedAt: new Date().toISOString(),
                },
            });

            logger.info({
                executionId,
                agentId: agent.id,
                agentName: agent.name,
                priority,
            }, 'Execution requested via API');

            // Return immediately with execution ID
            // The SDK will use Inngest to wait for actual completion
            return reply.code(202).send({
                executionId,
                status: 'pending',
                message: 'Execution queued successfully',
            });
        } catch (error: any) {
            logger.error({ error, agent: agentNameOrId }, 'Failed to queue execution');

            return reply.code(500).send({
                error: 'Internal server error',
                message: 'Failed to queue execution',
            });
        }
    });

    /**
     * GET /api/agents - List all agents
     * 
     * Returns all agents owned by the authenticated API key.
     * Results are paginated with default limit of 50.
     * 
     * Query params: limit?, offset?
     * Response: { agents: Agent[], total, limit, offset }
     */
    fastify.get('/api/agents', async (request: FastifyRequest, reply: FastifyReply) => {
        const apiKeyId = request.apiKeyId;
        if (!apiKeyId) {
            return reply.code(401).send({
                error: 'Unauthorized',
                message: 'Valid API key required',
            });
        }

        const query = request.query as any;
        const limit = Math.min(parseInt(query.limit) || 50, 100);
        const offset = parseInt(query.offset) || 0;

        try {
            const agentRegistry = getAgentRegistry();
            const agents = await agentRegistry.list(apiKeyId, limit, offset);

            return reply.send({
                agents: agents.map(agent => ({
                    id: agent.id,
                    name: agent.name,
                    image: agent.image,
                    description: agent.description,
                    resources: agent.resources,
                    retryPolicy: agent.retryPolicy,
                    createdAt: agent.createdAt.toISOString(),
                    updatedAt: agent.updatedAt.toISOString(),
                })),
                total: agents.length,
                limit,
                offset,
            });
        } catch (error) {
            logger.error({ error }, 'Failed to list agents');
            return reply.code(500).send({
                error: 'Internal server error',
                message: 'Failed to list agents',
            });
        }
    });

    /**
     * GET /api/agents/:agentId - Get agent details
     * 
     * Returns detailed information about a specific agent.
     * 
     * Response: Agent
     */
    fastify.get<{
        Params: { agentId: string };
    }>('/api/agents/:agentId', async (request, reply) => {
        const apiKeyId = request.apiKeyId;
        if (!apiKeyId) {
            return reply.code(401).send({
                error: 'Unauthorized',
                message: 'Valid API key required',
            });
        }

        const { agentId } = request.params;

        try {
            const agentRegistry = getAgentRegistry();
            const agent = await agentRegistry.get(apiKeyId, agentId);

            if (!agent) {
                return reply.code(404).send({
                    error: 'Not found',
                    message: 'Agent not found',
                });
            }

            return reply.send({
                id: agent.id,
                name: agent.name,
                image: agent.image,
                description: agent.description,
                resources: agent.resources,
                retryPolicy: agent.retryPolicy,
                useAgentSandbox: agent.useAgentSandbox,
                warmPoolSize: agent.warmPoolSize,
                networkPolicy: agent.networkPolicy,
                environmentVariables: agent.environmentVariables,
                createdAt: agent.createdAt.toISOString(),
                updatedAt: agent.updatedAt.toISOString(),
            });
        } catch (error) {
            logger.error({ error, agentId }, 'Failed to get agent');
            return reply.code(500).send({
                error: 'Internal server error',
                message: 'Failed to get agent',
            });
        }
    });

    /**
     * DELETE /api/agents/:agentId - Delete an agent
     * 
     * Permanently deletes an agent and all its execution history.
     * This is a destructive operation.
     * 
     * Response: { success: true, message }
     */
    fastify.delete<{
        Params: { agentId: string };
    }>('/api/agents/:agentId', async (request, reply) => {
        const apiKeyId = request.apiKeyId;
        if (!apiKeyId) {
            return reply.code(401).send({
                error: 'Unauthorized',
                message: 'Valid API key required',
            });
        }

        const { agentId } = request.params;

        try {
            const agentRegistry = getAgentRegistry();
            await agentRegistry.delete(apiKeyId, agentId);

            // Emit deletion event
            await inngest.send({
                name: 'agent.deleted',
                data: {
                    agentId,
                    apiKeyId: apiKeyId as string,
                    deletedAt: new Date().toISOString(),
                },
            });

            logger.info({ agentId }, 'Agent deleted via API');

            return reply.send({
                success: true,
                message: 'Agent deleted successfully',
            });
        } catch (error: any) {
            logger.error({ error, agentId }, 'Failed to delete agent');

            if (error.message.includes('not found')) {
                return reply.code(404).send({
                    error: 'Not found',
                    message: 'Agent not found',
                });
            }

            return reply.code(500).send({
                error: 'Internal server error',
                message: 'Failed to delete agent',
            });
        }
    });

    /**
     * GET /api/executions/:executionId - Get execution status
     * 
     * Returns the current status of an execution. This is used by the SDK
     * to poll for completion when waiting for an agent to finish running.
     * 
     * The execution goes through these states:
     * - pending: Created but not yet queued to a cluster
     * - queued: Waiting in cluster's work queue
     * - running: Agent is actively executing
     * - completed: Successfully finished with results
     * - failed: Failed after all retry attempts
     * 
     * Response: { executionId, status, result?, error?, durationMs?, ... }
     */
    fastify.get<{
        Params: { executionId: string };
    }>('/api/executions/:executionId', async (request, reply) => {
        const apiKeyId = request.apiKeyId;
        if (!apiKeyId) {
            return reply.code(401).send({
                error: 'Unauthorized',
                message: 'Valid API key required',
            });
        }

        const { executionId } = request.params;

        try {
            const prisma = await prismaManager.getClient();

            try {
                // Fetch the execution
                const execution = await prisma.execution.findUnique({
                    where: { id: executionId },
                    include: {
                        agent: {
                            select: {
                                apiKeyId: true, // Need this to verify ownership
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

                // Verify ownership
                if (execution.agent.apiKeyId !== apiKeyId) {
                    return reply.code(403).send({
                        error: 'Forbidden',
                        message: 'Access denied to this execution',
                    });
                }

                // Build response based on status
                const response: any = {
                    executionId: execution.id,
                    status: execution.status,
                    createdAt: execution.createdAt.toISOString(),
                };

                // Add timing information if available
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

                // Add result if completed
                if (execution.status === 'completed' && execution.result) {
                    response.result = execution.result;
                    response.resourceUsage = execution.resourceUsage || {
                        cpuSeconds: 0,
                        memoryMbSeconds: 0,
                    };
                }

                // Add error if failed
                if (execution.status === 'failed' && execution.error) {
                    response.error = {
                        message: execution.error,
                        code: 'execution_failed',
                    };
                }

                return reply.send(response);
            } finally {
                // No disconnect needed for prismaManager
            }
        } catch (error) {
            logger.error({ error, executionId }, 'Failed to get execution status');
            return reply.code(500).send({
                error: 'Internal server error',
                message: 'Failed to get execution status',
            });
        }
    });

    logger.info('API routes registered');
}