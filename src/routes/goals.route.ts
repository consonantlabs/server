/**
 * @fileoverview Goal Submission HTTP Route
 * @module api/routes/goals
 * 
 * @description
 * HTTP endpoint for goal submission.
 * Creates workflow and triggers orchestration.
 * 
 * @architecture
 * POST /goals → Validate → Persist → Emit Event → Return
 * 
 * @author Consonant Team
 * @version 0.1.0
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { validateGoalSubmission } from '../schemas/goal.schema.js';
import { emitOrchestrationTrigger } from '../services/inngest/client.js';
import { logger } from '../utils/logger.js';
import { generateUUID } from '../utils/crypto.js';
import { WorkflowStatus } from '@prisma/client';
import type { Prisma } from '@prisma/client';


// ============================================================================
// TYPES
// ============================================================================

interface GoalSubmissionRequest {
    /** User's goal description */
    goal: string;
    /** Optional metadata to attach to the workflow */
    context?: string;
}

interface GoalSubmissionResponse {
    /** Workflow ID */
    id: string;
    /** User's goal description */
    goal: string;
    /** Workflow status */
    status: WorkflowStatus;
    /** Trace ID for distributed tracing */
    traceId: string;
    /** Workflow creation timestamp */
    createdAt: string;
}


// ============================================================================
// ROUTE REGISTRATION
// ============================================================================

export async function goalRoutes(app: FastifyInstance) {
    /**
  * POST /goals - Submit a new workflow goal
  * 
  * @description
  * Entry point for workflow creation.
  * 
  * **Flow**:
  * 1. Validate request
  * 2. Create workflow record in database
  * 3. Emit orchestration.trigger event
  * 4. Return workflow ID
  * 
  * **Important**: This does NOT run orchestration synchronously.
  * Orchestration happens asynchronously via Inngest events.
  * 
  * @param req - Express request
  * @param res - Express response
  * 
  * @example
  * ```bash
  * curl -X POST http://localhost:3000/goals \
  *   -H "Content-Type: application/json" \
  *   -d '{"goal": "Deploy application to production"}'
  * ```
  */
    app.post('/goals', async (request: FastifyRequest, reply: FastifyReply) => {
        const startTime = Date.now();

        try {
            // Validate request body
            const validation = validateGoalSubmission(request.body);

            if (!validation.valid) {
                logger.warn(
                    { errors: validation.errors },
                    '[Goal Route] Goal submission validation failed'
                );
                return reply.code(400).send({
                    success: false,
                    error: 'Validation failed',
                    errors: validation.errors,
                });
            }

            const { goal, context } = validation.data as GoalSubmissionRequest;

            logger.info('[Goal Route] Creating workflow');

            // Generate trace ID for distributed tracing
            // Use request header if provided, otherwise generate new
            const traceId =
                (request.headers['x-trace-id'] as string) ||
                generateUUID();

            // Generate root span ID
            const rootSpanId = generateUUID();

            // Prepare event data outside transaction to keep it light
            const historyEventData: Prisma.InputJsonValue = {
                goal,
                context
            };

            // Create everything in a single nested create for maximum performance and atomicity
            const workflow = await request.prisma.workflow.create({
                data: {
                    goal,
                    status: WorkflowStatus.CREATED,
                    traceId,
                    rootSpanId,
                    context,
                    // Nested create for history
                    history: {
                        create: {
                            sequence: 0,
                            previousStatus: null,
                            newStatus: WorkflowStatus.CREATED,
                            eventType: 'workflow.created',
                            eventData: historyEventData,
                            reason: 'Goal submitted',
                            spanId: rootSpanId,
                        }
                    },
                    // Nested create for state
                    state: {
                        create: {
                            lastHistorySeq: 0,
                        }
                    }
                },
                // Include state in return so we have it for any follow-up logic
                include: { state: true }
            });

            logger.info(
                {
                    workflowId: workflow.id,
                    traceId,
                    durationMs: Date.now() - startTime,
                },
                '[Goal Route] Workflow created successfully'
            );

            // Emit orchestration trigger event
            // This will be picked up by the orchestration loop and start the workflow
            await emitOrchestrationTrigger(workflow.id, traceId, 'initial');

            return reply.code(201).send({
                success: true,
                data: {
                    id: workflow.id,
                    goal: workflow.goal,
                    status: workflow.status,
                    traceId: workflow.traceId,
                    createdAt: workflow.createdAt.toISOString(),
                } satisfies GoalSubmissionResponse,
            });

        } catch (error) {
            logger.error(
                {
                    error: error instanceof Error ? error.message : String(error),
                    stack: error instanceof Error ? error.stack : undefined,
                },
                '[Goal Route] Failed to create workflow from goal'
            );

            return reply.code(500).send({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
                message: 'Failed to create workflow from goal',
            });
        }
    });



    /**
     * GET /api/v1/goals/:id
     * 
     * Get workflow by ID with full status information.
     */
    app.get<{ Params: { id: string } }>('/goals/:id', async (request, reply) => {
        const { id } = request.params;

        const workflow = await request.prisma.workflow.findUnique({
            where: { id },
            include: {
                state: {
                    select: {
                        lastAgentResult: true,
                        lastHistorySeq: true,
                        retryCount: true,
                        errors: true,
                        currentStep: true,
                        errorCount: true,
                    },
                },
                history: {
                    orderBy: { sequence: 'desc' },
                    take: 1,
                    select: {
                        eventType: true,
                        reason: true,
                        timestamp: true,
                    },
                },
            },
        });

        if (!workflow) {
            return reply.code(404).send({
                success: false,
                error: 'Workflow not found',
            });
        }

        return {
            success: true,
            data: {
                id: workflow.id,
                goal: workflow.goal,
                status: workflow.status,
                traceId: workflow.traceId,
                currentStep: (workflow.state as any)?.currentStep || 0,
                errors: (workflow.state as any)?.errors || [],
                errorCount: (workflow.state as any)?.errorCount || 0,
                createdAt: workflow.createdAt.toISOString(),
                updatedAt: workflow.updatedAt.toISOString(),
                startedAt: workflow.startedAt?.toISOString() || null,
                completedAt: workflow.completedAt?.toISOString() || null
            },
        };
    });

    /**
     * GET /api/v1/goals
     * 
     * List workflows with pagination and filtering.
     */
    app.get('/goals', async (request, reply) => {
        const query = request.query as {
            status?: string;
            environment?: string;
            limit?: string;
            offset?: string;
        };

        const take = Math.min(parseInt(query.limit || '50', 10), 100);
        const skip = parseInt(query.offset || '0', 10);

        const where: Record<string, unknown> = {};

        if (query.status) {
            where.status = query.status as WorkflowStatus;
        }

        const [workflows, total] = await Promise.all([
            request.prisma.workflow.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                take,
                skip,
                select: {
                    id: true,
                    goal: true,
                    status: true,
                    traceId: true,
                    createdAt: true,
                    updatedAt: true,
                },
            }),
            request.prisma.workflow.count({ where }),
        ]);

        return {
            success: true,
            data: workflows.map((w) => ({
                ...w,
                createdAt: w.createdAt.toISOString(),
                updatedAt: w.updatedAt.toISOString(),
            })),
            pagination: {
                total,
                limit: take,
                offset: skip,
                hasMore: skip + take < total,
            },
        };
    });

    /**
     * GET /api/v1/goals/:id/history
     * 
     * Get full workflow history for debugging and replay.
     */
    app.get<{ Params: { id: string } }>('/goals/:id/history', async (request, reply) => {
        const { id } = request.params;

        const workflow = await request.prisma.workflow.findUnique({
            where: { id },
            select: { id: true },
        });

        if (!workflow) {
            return reply.code(404).send({
                success: false,
                error: 'Workflow not found',
            });
        }

        const history = await request.prisma.workflowHistory.findMany({
            where: { workflowId: id },
            orderBy: { sequence: 'asc' },
        });

        return {
            success: true,
            data: history.map((h) => ({
                ...h,
                timestamp: h.timestamp.toISOString(),
            })),
        };
    });
}
