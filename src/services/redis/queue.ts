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
 * Work item that gets queued for execution.
 * Contains everything the relayer needs to create the Agent CRD.
 */
export interface WorkItem {
    executionId: string;
    agentId: string;
    agentName: string;
    agentImage: string;
    input: Record<string, unknown>;
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
}

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
        clusterId: string,
        work: WorkItem,
        priority: Priority = 'normal'
    ): Promise<void> {
        const queueKey = this.getQueueKey(clusterId, priority);
        const workJson = JSON.stringify(work);

        try {
            // Push to the right side of the list (FIFO ordering)
            await this.redis.rpush(queueKey, workJson);

            logger.info({
                clusterId,
                executionId: work.executionId,
                priority,
                queueLength: await this.getQueueLength(clusterId, priority),
            }, 'Work item queued');
        } catch (error) {
            logger.error({
                error,
                clusterId,
                executionId: work.executionId,
            }, 'Failed to enqueue work item');
            throw new Error(`Failed to queue work: ${error}`);
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
        clusterId: string,
        timeoutSeconds: number = 30
    ): Promise<WorkItem | null> {
        // Build list of queues to check in priority order
        const queues = [
            this.getQueueKey(clusterId, 'high'),
            this.getQueueKey(clusterId, 'normal'),
            this.getQueueKey(clusterId, 'low'),
        ];

        try {
            // BLPOP atomically pops from the first non-empty queue
            // Format: [queueKey, value] or null if timeout
            const result = await this.redis.blpop(...queues, timeoutSeconds);

            if (!result) {
                // Timeout - no work available
                return null;
            }

            const [queueKey, workJson] = result;
            const work = JSON.parse(workJson) as WorkItem;

            logger.info({
                clusterId,
                executionId: work.executionId,
                queueKey,
            }, 'Work item dequeued');

            return work;
        } catch (error) {
            logger.error({
                error,
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
        clusterId: string,
        priority: Priority = 'normal'
    ): Promise<WorkItem | null> {
        const queueKey = this.getQueueKey(clusterId, priority);

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
        clusterId: string,
        priority?: Priority
    ): Promise<number> {
        try {
            if (priority) {
                // Get length of specific priority queue
                const queueKey = this.getQueueKey(clusterId, priority);
                return await this.redis.llen(queueKey);
            } else {
                // Get total across all priorities
                const high = await this.redis.llen(this.getQueueKey(clusterId, 'high'));
                const normal = await this.redis.llen(this.getQueueKey(clusterId, 'normal'));
                const low = await this.redis.llen(this.getQueueKey(clusterId, 'low'));
                return high + normal + low;
            }
        } catch (error) {
            logger.error({
                error,
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
    async clearClusterQueue(clusterId: string): Promise<WorkItem[]> {
        const cleared: WorkItem[] = [];

        for (const priority of ['high', 'normal', 'low'] as Priority[]) {
            const queueKey = this.getQueueKey(clusterId, priority);

            try {
                // Get all items from the queue
                const workItems = await this.redis.lrange(queueKey, 0, -1);

                for (const workJson of workItems) {
                    cleared.push(JSON.parse(workJson) as WorkItem);
                }

                // Delete the entire queue
                await this.redis.del(queueKey);

                logger.info({
                    clusterId,
                    priority,
                    count: workItems.length,
                }, 'Cleared cluster queue');
            } catch (error) {
                logger.error({
                    error,
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
     * Returns a summary of queue depths across all clusters.
     * Useful for monitoring and alerting on queue buildup.
     * 
     * @returns Map of cluster ID to queue statistics
     */
    async getGlobalStats(): Promise<Map<string, {
        high: number;
        normal: number;
        low: number;
        total: number;
    }>> {
        const stats = new Map();

        try {
            // Find all cluster queue keys
            const pattern = 'cluster:*:work*';
            const keys = await this.redis.keys(pattern);

            // Extract unique cluster IDs
            const clusterIds = new Set<string>();
            for (const key of keys) {
                const match = key.match(/^cluster:([^:]+):work/);
                if (match) {
                    clusterIds.add(match[1]);
                }
            }

            // Get stats for each cluster
            for (const clusterId of clusterIds) {
                const high = await this.getQueueLength(clusterId, 'high');
                const normal = await this.getQueueLength(clusterId, 'normal');
                const low = await this.getQueueLength(clusterId, 'low');

                stats.set(clusterId, {
                    high,
                    normal,
                    low,
                    total: high + normal + low,
                });
            }
        } catch (error) {
            logger.error({ error }, 'Failed to get global queue stats');
        }

        return stats;
    }

    /**
     * Build the Redis key for a cluster's queue.
     * 
     * Queue keys follow the pattern: cluster:{clusterId}:work:{priority}
     * Priority is omitted for normal priority to keep keys shorter.
     * 
     * @param clusterId - Cluster identifier
     * @param priority - Priority level
     * @returns Redis key string
     */
    private getQueueKey(clusterId: string, priority: Priority): string {
        const base = `cluster:${clusterId}:work`;
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