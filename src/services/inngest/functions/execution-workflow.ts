/**
 * @fileoverview Agent Execution Workflow
 * @module services/inngest/functions/execution-workflow
 * 
 * Production-grade Inngest function for orchestrating agent execution.
 * 
 * FLOW:
 * 1. Validate agent exists and get config
 * 2. Select best cluster for execution
 * 3. Queue work to cluster via Redis
 * 4. Wait for completion event from relayer
 * 5. Handle success or failure with retries
 * 
 * KEY PATTERNS:
 * - Each step is idempotent and durable
 * - Uses Inngest's waitForEvent for sync-like SDK experience
 * - Automatic retries with exponential backoff
 * - Organization-scoped multi-tenancy
 */

import { inngest } from '../client.js';
import { logger } from '../../../utils/logger.js';
import { prismaManager } from '../../db/manager.js';
import { getAgentService } from '../../agent.service.js';
import { getClusterService } from '../../cluster.selection.js';
import { getWorkQueue } from '../../redis/queue.js';
import type { WorkItem } from '../../redis/queue.js';

/**
 * Main execution workflow function.
 * Triggered by 'agent.execution.requested' event from SDK.
 */
export const executionWorkflow = inngest.createFunction(
    {
        id: 'agent-execution-workflow',
        name: 'Agent Execution Workflow',
        retries: 3,
        concurrency: {
            limit: 100,
            key: 'event.data.organizationId',
        },
    },
    { event: 'agent.execution.requested' },
    async ({ event, step }) => {
        const { executionId, agentId, organizationId, input, priority, cluster: preferredCluster } = event.data;

        logger.info({
            executionId,
            agentId,
            organizationId,
            priority,
        }, 'Execution workflow started');

        // =====================================================================
        // STEP 1: CREATE EXECUTION RECORD (DB)
        // =====================================================================
        await step.run('create-execution-db', async () => {
            const prisma = await prismaManager.getClient();
            const agentService = getAgentService();

            // 1. Validate Agent exists and is active
            const agent = await agentService.get(organizationId, agentId);
            if (!agent) throw new Error(`Agent ${agentId} not found`);
            if (agent.status !== 'ACTIVE') throw new Error(`Agent ${agent.name} is not active`);

            // 2. Create Execution (Upsert for idempotency)
            const execution = await prisma.execution.upsert({
                where: { id: executionId },
                update: {}, // No-op if exists
                create: {
                    id: executionId,
                    agentId: agent.id,
                    status: 'PENDING',
                    input: input as any, // Cast generic object to JsonValue
                    priority: priority?.toUpperCase() as any || 'NORMAL',
                    maxAttempts: (agent.retryPolicy as any)?.maxAttempts || 3,
                },
            });

            // 3. Log Audit Record
            await prisma.auditLog.create({
                data: {
                    organizationId,
                    action: 'EXECUTION_TRIGGERED',
                    resourceType: 'Execution',
                    resourceId: executionId,
                    metadata: {
                        agentId: agent.id,
                        agentName: agent.name,
                        priority
                    },
                }
            });

            return execution;
        });

        // =====================================================================
        // STEP 2: GET AGENT CONFIG
        // =====================================================================
        const agent = await step.run('get-agent-config', async () => {
            const agentService = getAgentService();
            const agentRecord = await agentService.get(organizationId, agentId);
            // We know it exists from Step 1, but type safety needs it
            if (!agentRecord) throw new Error(`Agent ${agentId} not found`);

            return {
                id: agentRecord.id,
                name: agentRecord.name,
                image: agentRecord.image,
                resources: agentRecord.resources as any,
                retryPolicy: agentRecord.retryPolicy as any,
                useAgentSandbox: agentRecord.useAgentSandbox,
                warmPoolSize: agentRecord.warmPoolSize,
                networkPolicy: agentRecord.networkPolicy,
                environmentVariables: agentRecord.environmentVariables as any,
            };
        });

        // =====================================================================
        // STEP 2: SELECT CLUSTER
        // =====================================================================
        const selectedCluster = await step.run('select-cluster', async () => {
            const prisma = await prismaManager.getClient();
            const clusterService = getClusterService();

            // Try preferred cluster first
            if (preferredCluster) {
                const cluster = await prisma.cluster.findFirst({
                    where: {
                        id: preferredCluster,
                        organizationId,
                        status: 'ACTIVE',
                    },
                });

                if (cluster) {
                    logger.info({ executionId, clusterId: cluster.id }, 'Using preferred cluster');
                    return cluster;
                }
                logger.warn({ executionId, preferredCluster }, 'Preferred cluster not available');
            }

            // Auto-select best cluster
            const cluster = await clusterService.selectCluster(
                organizationId,
                {
                    resources: agent.resources,
                    useAgentSandbox: agent.useAgentSandbox,
                },
                {
                    requireGpu: !!agent.resources.gpu,
                    requireSandbox: agent.useAgentSandbox,
                }
            );

            logger.info({
                executionId,
                clusterId: cluster.id,
                clusterName: cluster.name,
            }, 'Cluster selected');

            return cluster;
        });

        // =====================================================================
        // STEP 3: UPDATE STATUS & QUEUE WORK
        // =====================================================================
        await step.run('queue-work', async () => {
            const prisma = await prismaManager.getClient();
            const workQueue = getWorkQueue();

            // Update execution with cluster assignment
            await prisma.execution.update({
                where: { id: executionId },
                data: {
                    clusterId: selectedCluster.id,
                    status: 'QUEUED',
                    queuedAt: new Date(),
                },
            });

            // Build work item for relayer
            const workItem: WorkItem = {
                executionId,
                agentId: agent.id,
                agentName: agent.name,
                agentImage: agent.image,
                input: input as any,
                resources: {
                    cpu: agent.resources.cpu,
                    memory: agent.resources.memory,
                    gpu: agent.resources.gpu,
                    timeout: agent.resources.timeout,
                },
                retryPolicy: {
                    maxAttempts: agent.retryPolicy.maxAttempts,
                    backoff: agent.retryPolicy.backoff,
                    initialDelay: agent.retryPolicy.initialDelay,
                },
                useAgentSandbox: agent.useAgentSandbox,
                warmPoolSize: agent.warmPoolSize,
                networkPolicy: agent.networkPolicy,
                environmentVariables: agent.environmentVariables,
            };

            // Queue to Redis for gRPC pickup
            await workQueue.enqueue(
                selectedCluster.id,
                workItem,
                priority as any || 'normal'
            );

            // Emit queued event
            await inngest.send({
                name: 'agent.execution.queued',
                data: {
                    executionId,
                    agentId: agent.id,
                    clusterId: selectedCluster.id,
                    queuedAt: new Date().toISOString(),
                },
            });

            logger.info({
                executionId,
                clusterId: selectedCluster.id,
            }, 'Work queued to cluster');
        });

        // =====================================================================
        // STEP 4: WAIT FOR COMPLETION (up to timeout)
        // =====================================================================
        const timeoutMs = parseTimeout(agent.resources.timeout) + 60000; // Add 1min buffer

        const completionEvent = await step.waitForEvent('wait-for-completion', {
            event: 'agent.execution.completed',
            match: 'data.executionId',
            timeout: `${Math.ceil(timeoutMs / 1000)}s`,
        });

        // =====================================================================
        // STEP 5: PROCESS RESULT
        // =====================================================================
        if (completionEvent) {
            // Execution completed successfully
            await step.run('process-success', async () => {
                const prisma = await prismaManager.getClient();

                await prisma.execution.update({
                    where: { id: executionId },
                    data: {
                        status: 'COMPLETED',
                        result: completionEvent.data.result as any,
                        completedAt: new Date(),
                        durationMs: completionEvent.data.durationMs,
                        resourceUsage: completionEvent.data.resourceUsage as any,
                    },
                });

                logger.info({
                    executionId,
                    durationMs: completionEvent.data.durationMs,
                }, 'Execution completed successfully');
            });

            return {
                status: 'completed',
                executionId,
                result: completionEvent.data.result,
                durationMs: completionEvent.data.durationMs,
            };
        }

        // =====================================================================
        // TIMEOUT OR FAILURE HANDLING
        // =====================================================================
        await step.run('handle-timeout', async () => {
            const prisma = await prismaManager.getClient();

            await prisma.execution.update({
                where: { id: executionId },
                data: {
                    status: 'FAILED',
                    error: 'Execution timed out waiting for completion',
                    completedAt: new Date(),
                },
            });

            logger.warn({ executionId }, 'Execution timed out');
        });

        return {
            status: 'timeout',
            executionId,
            error: 'Execution timed out',
        };
    }
);

/**
 * Handler for execution failures from relayer.
 * Implements retry logic with exponential backoff.
 */
export const executionFailureHandler = inngest.createFunction(
    {
        id: 'agent-execution-failure-handler',
        name: 'Agent Execution Failure Handler',
        retries: 0, // We handle our own retries
    },
    { event: 'agent.execution.failed' },
    async ({ event, step }) => {
        const { executionId, error, attempt } = event.data;
        const maxAttempts = 3; // Default max attempts or could fetch from DB

        logger.warn({
            executionId,
            error: error.message,
            attempt,
            maxAttempts,
        }, 'Execution failed');

        // Check if we should retry
        if (attempt < maxAttempts) {
            await step.run('schedule-retry', async () => {
                const prisma = await prismaManager.getClient();

                // Get execution with agent for retry
                const execution = await prisma.execution.findUnique({
                    where: { id: executionId },
                    include: { agent: true },
                });

                if (!execution) {
                    throw new Error(`Execution ${executionId} not found`);
                }

                // Calculate backoff delay
                const retryPolicy = execution.agent.retryPolicy as any;
                const delaySeconds = calculateBackoff(attempt, retryPolicy);
                const nextRetryAt = new Date(Date.now() + delaySeconds * 1000);

                // Update execution
                await prisma.execution.update({
                    where: { id: executionId },
                    data: {
                        attempt: attempt + 1,
                        nextRetryAt,
                        status: 'PENDING',
                    },
                });

                // Schedule retry via Inngest with delay
                await inngest.send({
                    name: 'agent.execution.requested',
                    data: {
                        executionId,
                        agentId: execution.agentId,
                        organizationId: execution.agent.organizationId,
                        input: execution.input as any,
                        priority: 'normal',
                        requestedAt: new Date().toISOString(),
                    },
                    ts: Date.now() + (delaySeconds * 1000),
                });

                logger.info({
                    executionId,
                    nextAttempt: attempt + 1,
                    delaySeconds,
                }, 'Retry scheduled');
            });

            return { status: 'retry_scheduled', nextAttempt: attempt + 1 };
        }

        // Max retries exceeded - mark as permanently failed
        await step.run('mark-failed', async () => {
            const prisma = await prismaManager.getClient();

            await prisma.execution.update({
                where: { id: executionId },
                data: {
                    status: 'FAILED',
                    error: `Failed after ${maxAttempts} attempts: ${error.message}`,
                    completedAt: new Date(),
                },
            });

            logger.error({
                executionId,
                attempts: maxAttempts,
            }, 'Execution permanently failed');
        });

        return { status: 'permanently_failed', attempts: maxAttempts };
    }
);

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Parse timeout string to milliseconds.
 * Supports formats: "300s", "5m", "1h"
 */
function parseTimeout(timeout: string): number {
    const match = timeout.match(/^(\d+)(s|m|h)$/);
    if (!match) return 300000; // Default 5 minutes

    const value = parseInt(match[1]);
    const unit = match[2];

    switch (unit) {
        case 's': return value * 1000;
        case 'm': return value * 60 * 1000;
        case 'h': return value * 60 * 60 * 1000;
        default: return 300000;
    }
}

/**
 * Calculate retry backoff delay in seconds.
 */
function calculateBackoff(attempt: number, retryPolicy: any): number {
    const initialDelay = parseTimeout(retryPolicy.initialDelay || '1s') / 1000;

    switch (retryPolicy.backoff) {
        case 'exponential':
            return initialDelay * Math.pow(2, attempt);
        case 'linear':
            return initialDelay * (attempt + 1);
        case 'constant':
        default:
            return initialDelay;
    }
}