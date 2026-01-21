/**
 * @fileoverview Work Queue Service
 * @module services/work-queue
 * 
 * This service implements the work distribution system using Redis.
 * Each Kubernetes cluster has its own Redis list that acts as a work queue.
 * When an execution is ready to run, it gets pushed to the appropriate
 * cluster's queue, where the relayer will pick it up via gRPC stream.
 * 
 * ARCHITECTURAL INSIGHT:
 * We use Redis for the work queue because it provides microsecond latency
 * for the hot path. When work arrives, the gRPC server can immediately
 * detect it and push to the waiting relayer. This is much faster than
 * polling or using a slower message queue.
 * 
 * QUEUE STRUCTURE:
 * Each cluster has a queue: `cluster:{clusterId}:work`
 * High-priority items go to: `cluster:{clusterId}:work:high`
 * We check the high-priority queue first, then fall back to normal queue.
 */

import { Redis } from 'ioredis';
import { logger } from '../../utils/logger.js';

/**
 * ARCHITECTURAL DESIGN: Work vs Registration payload separation.
 * To optimize the hot path, execution events are kept "thin".
 * High-volume configuration (registration) is handled as a separate lifecycle event.
 */

/**
 * Lean work item for the execution hot path.
 */
export interface WorkItem {
    executionId: string;
    agentName: string;
    input: Record<string, unknown>;
    priority?: Priority;
}

/**
 * Detailed registration item for configuring the edge environment.
 */
export interface RegistrationItem {
    agentId: string;
    agentName: string;
    image: string;
    resources: {
        cpu: string;
        memory: string;
        gpu?: string;
        timeout: string;
    };
    retryPolicy: {
        maxAttempts: number;
        backoff: 'exponential' | 'linear' | 'constant';
        initialDelay?: string;
    };
    useAgentSandbox: boolean;
    warmPoolSize: number;
    networkPolicy: string;
    environmentVariables?: Record<string, string>;
    configHash: string;
}

/**
 * Discriminated union for all messages pushed to the cluster relayer.
 */
export type QueueMessage =
    | { type: 'WORK'; data: WorkItem }
    | { type: 'REGISTRATION'; data: RegistrationItem };

/**
 * Priority levels for execution queueing.
 * High priority executions jump to the front of the queue.
 */
export type Priority = 'high' | 'normal' | 'low';

/**
 * Work Queue Service
 * 
 * Manages Redis-based work queues for distributing executions to clusters.
 * Provides high-throughput, low-latency work distribution with priority support.
 */
export class WorkQueueService {
    private redis: Redis;

    constructor(redis: Redis) {
        this.redis = redis;
    }

    /**
     * Queue an execution for a specific cluster.
     * 
     * The work item is serialized to JSON and pushed to the cluster's queue.
     * High-priority items go to a separate queue that's checked first.
     * 
     * @param clusterId - Which cluster should handle this execution
     * @param work - Complete execution details
     * @param priority - Queue priority level
     * @returns Promise that resolves when queued
     * 
     * @example
     * ```typescript
     * await workQueue.enqueue('cluster_abc123', {
     *   executionId: 'exec_xyz789',
     *   agentImage: 'docker.io/acme/agent:v1',
     *   input: { query: 'test' },
     *   // ... other fields
     * }, 'high');
     * ```
     */
    async enqueue(
        organizationId: string,
        clusterId: string,
        item: QueueMessage,
        priority: Priority = 'normal'
    ): Promise<void> {
        const queueKey = this.getQueueKey(clusterId, organizationId, priority);
        const payloadJson = JSON.stringify(item);

        try {
            await this.redis.rpush(queueKey, payloadJson);

            logger.info({
                organizationId,
                clusterId,
                type: item.type,
                id: item.type === 'WORK' ? item.data.executionId : item.data.agentName,
                priority,
            }, 'Queue item pushed');
        } catch (error) {
            logger.error({
                error,
                organizationId,
                clusterId,
            }, 'Failed to enqueue item');
            throw new Error(`Failed to queue item: ${error}`);
        }
    }

    /**
     * Dequeue the next work item for a cluster.
     * 
     * Checks high-priority queue first, then normal queue, then low priority.
     * Uses BLPOP (blocking left pop) so it waits if queues are empty.
     * 
     * This method is called by the gRPC server when it needs to push work
     * to a relayer. It blocks until work is available or timeout is reached.
     * 
     * @param clusterId - Which cluster is requesting work
     * @param timeoutSeconds - How long to wait if queues are empty
     * @returns Work item if available, null if timeout
     * 
     * @example
     * ```typescript
     * // Wait up to 30 seconds for work
     * const work = await workQueue.dequeue('cluster_abc123', 30);
     * if (work) {
     *   // Push to relayer via gRPC stream
     *   stream.write(work);
     * }
     * ```
     */
    async dequeue(
        organizationId: string,
        clusterId: string,
        timeoutSeconds: number = 30
    ): Promise<QueueMessage | null> {
        // Build list of queues to check in priority order
        const queues = [
            this.getQueueKey(clusterId, organizationId, 'high'),
            this.getQueueKey(clusterId, organizationId, 'normal'),
            this.getQueueKey(clusterId, organizationId, 'low'),
        ];

        try {
            // BLPOP atomically pops from the first non-empty queue
            // Format: [queueKey, value] or null if timeout
            const result = await this.redis.blpop(...queues, timeoutSeconds);

            if (!result) {
                // Timeout - no work available
                return null;
            }

            const [queueKey, payloadJson] = result;
            const message = JSON.parse(payloadJson) as QueueMessage;

            logger.info({
                organizationId,
                clusterId,
                type: message.type,
                queueKey,
            }, 'Queue item dequeued');

            return message;
        } catch (error) {
            logger.error({
                error,
                organizationId,
                clusterId,
            }, 'Failed to dequeue work item');
            throw new Error(`Failed to dequeue work: ${error}`);
        }
    }

    /**
     * Peek at the next work item without removing it.
     * 
     * Useful for monitoring and debugging - see what's queued without
     * actually consuming it.
     * 
     * @param clusterId - Which cluster's queue to peek
     * @param priority - Which priority level to check
     * @returns Next work item or null if queue is empty
     */
    async peek(
        organizationId: string,
        clusterId: string,
        priority: Priority = 'normal'
    ): Promise<WorkItem | null> {
        const queueKey = this.getQueueKey(clusterId, organizationId, priority);

        try {
            // LINDEX 0 gets the leftmost (next) item without removing it
            const workJson = await this.redis.lindex(queueKey, 0);

            if (!workJson) {
                return null;
            }

            return JSON.parse(workJson) as WorkItem;
        } catch (error) {
            logger.error({
                error,
                organizationId,
                clusterId,
                priority,
            }, 'Failed to peek at queue');
            return null;
        }
    }

    /**
     * Get the current length of a cluster's queue.
     * 
     * Returns the number of pending work items waiting to be executed.
     * Useful for monitoring and load balancing decisions.
     * 
     * @param clusterId - Which cluster's queue to check
     * @param priority - Which priority level to check (optional, returns total if omitted)
     * @returns Number of items in queue
     */
    async getQueueLength(
        organizationId: string,
        clusterId: string,
        priority?: Priority
    ): Promise<number> {
        try {
            if (priority) {
                // Get length of specific priority queue
                const queueKey = this.getQueueKey(clusterId, organizationId, priority);
                return await this.redis.llen(queueKey);
            } else {
                // Get total across all priorities
                const high = await this.redis.llen(this.getQueueKey(clusterId, organizationId, 'high'));
                const normal = await this.redis.llen(this.getQueueKey(clusterId, organizationId, 'normal'));
                const low = await this.redis.llen(this.getQueueKey(clusterId, organizationId, 'low'));
                return high + normal + low;
            }
        } catch (error) {
            logger.error({
                error,
                organizationId,
                clusterId,
                priority,
            }, 'Failed to get queue length');
            return 0;
        }
    }

    /**
     * Clear all pending work for a cluster.
     * 
     * Used when a cluster disconnects unexpectedly - we need to requeue
     * its work to other clusters or mark executions as failed.
     * 
     * @param clusterId - Which cluster's queues to clear
     * @returns Array of work items that were cleared
     */
    async clearClusterQueue(organizationId: string, clusterId: string): Promise<WorkItem[]> {
        const cleared: WorkItem[] = [];

        for (const priority of ['high', 'normal', 'low'] as Priority[]) {
            const queueKey = this.getQueueKey(clusterId, organizationId, priority);

            try {
                // Get all items from the queue
                const workItems = await this.redis.lrange(queueKey, 0, -1);

                for (const workJson of workItems) {
                    cleared.push(JSON.parse(workJson) as WorkItem);
                }

                // Delete the entire queue
                await this.redis.del(queueKey);

                logger.info({
                    organizationId,
                    clusterId,
                    priority,
                    count: workItems.length,
                }, 'Cleared cluster queue');
            } catch (error) {
                logger.error({
                    error,
                    organizationId,
                    clusterId,
                    priority,
                }, 'Failed to clear cluster queue');
            }
        }

        return cleared;
    }

    /**
     * Get statistics about all queues in the system.
     * 
     * Scans Redis for all queue keys and aggregates totals.
     * 
     * @returns Map of "org:cluster" to queue statistics
     */
    async getGlobalStats(): Promise<Map<string, {
        high: number;
        normal: number;
        low: number;
        total: number;
    }>> {
        const stats = new Map();

        try {
            // Find all cluster queue keys across all orgs using non-blocking SCAN
            const pattern = 'org:*:cluster:*:work*';
            const targets = new Set<string>();

            let cursor = '0';
            do {
                const [nextCursor, keys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
                cursor = nextCursor;

                for (const key of keys) {
                    const match = key.match(/^org:([^:]+):cluster:([^:]+):work/);
                    if (match) {
                        targets.add(`${match[1]}:${match[2]}`);
                    }
                }
            } while (cursor !== '0');

            // Get stats for each target
            for (const target of targets) {
                const [orgId, clusterId] = target.split(':');
                const high = await this.getQueueLength(orgId, clusterId, 'high');
                const normal = await this.getQueueLength(orgId, clusterId, 'normal');
                const low = await this.getQueueLength(orgId, clusterId, 'low');

                stats.set(target, {
                    high,
                    normal,
                    low,
                    total: high + normal + low,
                });
            }
        } catch (error) {
            logger.error({ error }, 'Failed to get global queue stats via SCAN');
        }

        return stats;
    }

    /**
     * Build the Redis key for a cluster's queue.
     * 
     * Pattern: org:{orgId}:cluster:{clusterId}:work[:{priority}]
     * 
     * @param clusterId - Cluster identifier
     * @param organizationId - Organization identifier
     * @param priority - Priority level
     * @returns Redis key string
     */
    private getQueueKey(clusterId: string, organizationId: string, priority: Priority): string {
        const base = `org:${organizationId}:cluster:${clusterId}:work`;
        return priority === 'normal' ? base : `${base}:${priority}`;
    }
}

/**
 * Singleton instance of the work queue service.
 * Initialized in server.ts with the Redis client.
 */
let workQueueInstance: WorkQueueService | null = null;

/**
 * Initialize the work queue service.
 * Must be called once during server startup with the Redis client.
 * 
 * @param redis - Configured Redis client
 */
export function initWorkQueue(redis: Redis): void {
    workQueueInstance = new WorkQueueService(redis);
    logger.info('Work queue service initialized');
}

/**
 * Get the work queue service instance.
 * Throws if not initialized.
 * 
 * @returns WorkQueueService instance
 */
export function getWorkQueue(): WorkQueueService {
    if (!workQueueInstance) {
        throw new Error('Work queue not initialized. Call initWorkQueue() first.');
    }
    return workQueueInstance;
}