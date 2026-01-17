/**
 * @fileoverview Agent Execution Workflow
 * @module inngest/functions/execution-workflow
 * 
 * This is the CORE of the Consonant agent execution platform.
 * 
 * When a user calls execute() in the SDK, it triggers this Inngest function.
 * The function orchestrates the complete lifecycle of running an agent:
 * 
 * 1. Create execution record in database
 * 2. Select the best cluster for this execution
 * 3. Queue the work to that cluster's Redis queue
 * 4. WAIT for completion (could take seconds, minutes, or hours)
 * 5. Return the result to the SDK caller
 * 
 * THE KEY INNOVATION:
 * Step 4 uses Inngest's waitForEvent() which suspends the function without
 * consuming resources. The SDK's execute() call appears synchronous to the
 * user, even though the agent might run for 30 minutes. When the agent
 * completes, Inngest wakes up this function right where it left off and
 * returns the result.
 * 
 * This gives you:
 * - Synchronous semantics (SDK returns the result)
 * - Over asynchronous distributed execution (agent runs in Kubernetes)
 * - With full durability (survives server restarts)
 * - And zero polling (no wasteful status checks)
 */

import { inngest } from '../client.js';
import { prismaManager } from '../../db/manager.js';
import { getAgentRegistry } from '../../agent-registry.js';
import { getClusterSelection } from '../../cluster-selection.js';
import { getWorkQueue, type WorkItem } from '../../redis/queue.js';
import { logger } from '../../../utils/logger.js';
import type { AgentOutput, ResourceUsage } from '../events.js';

/**
 * Agent Execution Workflow
 * 
 * This is the durable orchestration function that manages agent execution
 * from start to finish. Each step is automatically checkpointed by Inngest,
 * so if the server crashes, execution resumes from the last completed step.
 */
export const executionWorkflow = inngest.createFunction(
    {
        id: 'agent-execution-workflow',
        name: 'Agent Execution Workflow',
        // Retry configuration for the workflow itself
        retries: 3,
        // Concurrency limit to prevent overwhelming the database
        concurrency: {
            limit: 100,
            key: 'event.data.apiKeyId', // Limit per customer
        },
    },
    // Trigger: When SDK calls execute()
    { event: 'agent.execution.requested' },
    async ({ event, step }) => {
        const { executionId, agentId, apiKeyHash: apiKeyId, input, priority, cluster: preferredCluster } = event.data;

        logger.info({
            executionId,
            agentId,
            priority,
            apiKeyId,
        }, 'Execution workflow started');

        // =========================================================================
        // STEP 1: CREATE EXECUTION RECORD
        // =========================================================================

        const execution = await step.run('create-execution', async () => {
            const prisma = await prismaManager.getClient();

            try {
                // Fetch agent configuration (needed for cluster selection)
                const agentRegistry = getAgentRegistry();
                const agent = await agentRegistry.get(apiKeyId, agentId);

                if (!agent) {
                    throw new Error(`Agent ${agentId} not found for API key`);
                }

                // Create the execution record
                const exec = await prisma.execution.create({
                    data: {
                        id: executionId,
                        agentId: agent.id,
                        status: 'pending',
                        input: input as any,
                        maxAttempts: (agent.retryPolicy as any)?.maxAttempts || 3,
                    },
                });

                logger.info({
                    executionId,
                    agentId: agent.id,
                    status: 'pending',
                }, 'Execution record created');

                return {
                    executionId: exec.id,
                    agent: {
                        id: agent.id,
                        name: agent.name,
                        image: agent.image,
                        resources: agent.resources,
                        retryPolicy: agent.retryPolicy,
                        useAgentSandbox: agent.useAgentSandbox,
                        warmPoolSize: agent.warmPoolSize,
                        networkPolicy: agent.networkPolicy,
                        environmentVariables: agent.environmentVariables,
                    },
                };
            } finally {
                // No disconnect needed for prismaManager
            }
        });

        // =========================================================================
        // STEP 2: SELECT CLUSTER
        // =========================================================================

        const selectedCluster = await step.run('select-cluster', async () => {
            const prisma = await prismaManager.getClient();

            try {
                const clusterSelection = getClusterSelection();

                // If user specified a preferred cluster, try to use it
                if (preferredCluster) {
                    const cluster = await prisma.cluster.findFirst({
                        where: {
                            id: preferredCluster,
                            organizationId: (await prisma.apiKey.findUnique({ where: { id: apiKeyId } }))?.organizationId,
                            status: 'ACTIVE',
                        },
                    });

                    if (cluster) {
                        logger.info({
                            executionId,
                            clusterId: cluster.id,
                        }, 'Using preferred cluster');
                        return cluster;
                    } else {
                        logger.warn({
                            executionId,
                            preferredCluster,
                        }, 'Preferred cluster not available, selecting automatically');
                    }
                }

                // Select best cluster based on requirements and load
                const cluster = await clusterSelection.selectCluster(
                    apiKeyId,
                    {
                        resources: execution.agent.resources as any,
                        useAgentSandbox: execution.agent.useAgentSandbox,
                    },
                    {
                        requireGpu: !!(execution.agent.resources as any).gpu,
                        requireSandbox: execution.agent.useAgentSandbox,
                    }
                );

                // Update execution record with selected cluster
                await prisma.execution.update({
                    where: { id: executionId },
                    data: { clusterId: cluster.id },
                });

                logger.info({
                    executionId,
                    clusterId: cluster.id,
                    clusterName: cluster.name,
                }, 'Cluster selected');

                return cluster;
            } finally {
                // No disconnect needed for prismaManager
            }
        });

        // =========================================================================
        // STEP 3: QUEUE WORK TO CLUSTER
        // =========================================================================

        await step.run('queue-work', async () => {
            const prisma = await prismaManager.getClient();

            try {
                const workQueue = getWorkQueue();

                // Build work item with all details the relayer needs
                const workItem: WorkItem = {
                    executionId,
                    agentId: execution.agent.id,
                    agentName: execution.agent.name,
                    agentImage: execution.agent.image,
                    input: input,
                    resources: execution.agent.resources as any,
                    retryPolicy: execution.agent.retryPolicy as any,
                    useAgentSandbox: execution.agent.useAgentSandbox,
                    warmPoolSize: execution.agent.warmPoolSize,
                    networkPolicy: execution.agent.networkPolicy,
                    environmentVariables: (execution.agent.environmentVariables as any) || {},
                };

                // Push to cluster's Redis queue
                await workQueue.enqueue(
                    selectedCluster.id,
                    workItem,
                    priority
                );

                // Update execution status to "queued"
                await prisma.execution.update({
                    where: { id: executionId },
                    data: {
                        status: 'queued',
                        queuedAt: new Date(),
                    },
                });

                // Emit event for monitoring
                await inngest.send({
                    name: 'agent.execution.queued',
                    data: {
                        executionId,
                        agentId: execution.agent.id,
                        clusterId: selectedCluster.id,
                        queuedAt: new Date().toISOString(),
                    },
                });

                logger.info({
                    executionId,
                    clusterId: selectedCluster.id,
                    priority,
                }, 'Work queued to cluster');
            } finally {
                // No disconnect needed for prismaManager
            }
        });

        // =========================================================================
        // STEP 4: WAIT FOR COMPLETION
        // =========================================================================
        // 
        // THIS IS THE MAGIC STEP
        // 
        // The function suspends here until the agent completes (or timeout).
        // During this time:
        // - The SDK's execute() call is waiting
        // - The server can restart, deploy new code, anything
        // - No resources are consumed
        // - Inngest maintains the state
        // 
        // When 'agent.execution.completed' event fires (sent by gRPC server when
        // relayer reports completion), Inngest wakes up this function right here
        // and continues to step 5.
        // =========================================================================

        const completionResult = await step.waitForEvent('wait-for-completion', {
            event: 'agent.execution.completed',
            match: 'data.executionId',
            timeout: '2h', // Maximum time to wait
        });

        // Check if we got completion or timeout
        if (!completionResult) {
            // Timeout - agent took too long
            logger.error({
                executionId,
                timeout: '2h',
            }, 'Execution timed out waiting for completion');

            // Mark execution as failed
            try {
                const prisma = await prismaManager.getClient();
                await prisma.execution.update({
                    where: { id: executionId },
                    data: {
                        status: 'failed',
                        error: 'Execution timed out after 2 hours',
                        completedAt: new Date(),
                    },
                });
            } finally {
                // No disconnect needed
            }

            throw new Error('Execution timed out');
        }

        // =========================================================================
        // STEP 5: RETURN RESULT
        // =========================================================================

        const { result, durationMs, resourceUsage } = completionResult.data;

        logger.info({
            executionId,
            durationMs,
            status: 'completed',
        }, 'Execution completed successfully');

        // Return the result - this goes back to the SDK caller!
        // The user's execute() call finally resolves with this value
        return {
            executionId,
            status: 'completed' as const,
            result: result as AgentOutput,
            durationMs,
            resourceUsage: resourceUsage as ResourceUsage,
            completedAt: new Date().toISOString(),
        };
    }
);

/**
 * Agent Execution Failure Handler
 * 
 * Handles failed executions and implements retry logic.
 * When an agent fails, this function determines if we should retry
 * and reschedules if appropriate.
 */
export const executionFailureHandler = inngest.createFunction(
    {
        id: 'agent-execution-failure-handler',
        name: 'Agent Execution Failure Handler',
    },
    { event: 'agent.execution.failed' },
    async ({ event, step }) => {
        const { executionId, error, attempt, willRetry } = event.data;

        logger.warn({
            executionId,
            attempt,
            error,
            willRetry,
        }, 'Execution failed');

        if (!willRetry) {
            // No more retries - mark as permanently failed
            await step.run('mark-exhausted', async () => {
                try {
                    const prisma = await prismaManager.getClient();
                    await prisma.execution.update({
                        where: { id: executionId },
                        data: {
                            status: 'failed',
                            error: `Failed after ${attempt} attempts: ${error.message}`,
                            completedAt: new Date(),
                        },
                    });

                    // Emit exhausted event
                    await inngest.send({
                        name: 'agent.execution.exhausted',
                        data: {
                            executionId,
                            agentId: event.data.agentId,
                            error: {
                                code: error.code,
                                message: error.message,
                                allAttempts: [], // Would need to fetch from execution history
                            },
                            exhaustedAt: new Date().toISOString(),
                        },
                    });

                    logger.error({
                        executionId,
                        finalAttempt: attempt,
                    }, 'Execution permanently failed');
                } finally {
                    // No disconnect needed
                }
            });

            // Wake up the waiting workflow with failure
            await inngest.send({
                name: 'agent.execution.completed',
                data: {
                    executionId,
                    agentId: event.data.agentId,
                    clusterId: event.data.clusterId,
                    result: {},
                    durationMs: 0,
                    resourceUsage: {
                        cpuSeconds: 0,
                        memoryMbSeconds: 0,
                    },
                    completedAt: new Date().toISOString(),
                },
            });
        } else {
            // Will retry - reschedule the execution
            await step.run('schedule-retry', async () => {
                try {
                    const prisma = await prismaManager.getClient();
                    // Get execution record to find agent details
                    const execution = await prisma.execution.findUnique({
                        where: { id: executionId },
                        include: { agent: true },
                    });

                    if (!execution) {
                        logger.error({ executionId }, 'Execution not found for retry');
                        return;
                    }

                    // Calculate retry delay based on backoff strategy
                    const retryPolicy = execution.agent.retryPolicy as {
                        backoff: 'exponential' | 'linear' | 'constant';
                        initialDelay?: string;
                    };

                    let delaySeconds = 1;
                    if (retryPolicy.backoff === 'exponential') {
                        delaySeconds = Math.pow(2, attempt - 1); // 1s, 2s, 4s, 8s, ...
                    } else if (retryPolicy.backoff === 'linear') {
                        delaySeconds = attempt; // 1s, 2s, 3s, 4s, ...
                    }

                    const nextRetryAt = new Date(Date.now() + delaySeconds * 1000);

                    // Update execution for next attempt
                    await prisma.execution.update({
                        where: { id: executionId },
                        data: {
                            attempt: attempt + 1,
                            nextRetryAt,
                            status: 'pending',
                        },
                    });

                    logger.info({
                        executionId,
                        nextAttempt: attempt + 1,
                        delaySeconds,
                    }, 'Retry scheduled');

                    // Schedule retry using Inngest's built-in delay mechanism
                    // This ensures the retry happens at the right time even if the server restarts
                    await inngest.send({
                        name: 'agent.execution.requested',
                        data: {
                            executionId,
                            agentId: execution.agentId,
                            apiKeyId: execution.agent.apiKeyId, // Renamed from apiKeyHash
                            input: execution.input as any,
                            priority: 'normal',
                            requestedAt: new Date().toISOString(),
                        },
                        // Inngest will delay this event by the calculated retry delay
                        ts: Date.now() + (delaySeconds * 1000),
                    });
                } finally {
                    // No disconnect needed
                }
            });
        }
    }
);