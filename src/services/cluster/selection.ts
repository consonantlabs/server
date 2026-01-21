/**
 * @fileoverview Cluster Selection Logic
 * @module services/cluster/selection
 * 
 * Implements the selection, filtering, and scoring algorithms for choosing
 * the optimal cluster for agent execution.
 */

import { Cluster, PrismaClient } from '@prisma/client';
import { logger } from '../../utils/logger.js';
import { getWorkQueue } from '../redis/work-queue.js';
import type { AgentConfig } from '../inngest/events.js';

/**
 * Cluster capabilities structure.
 */
export interface ClusterCapabilities {
    kubernetes: {
        version: string;
        provider?: string;
    };
    resources: {
        totalCpu: string;
        totalMemory: string;
        gpuNodes: number;
        gpuType?: string;
    };
    region?: string;
    availabilityZone?: string;
}

/**
 * Selection preferences.
 */
export interface SelectionPreferences {
    preferredRegion?: string;
    requireGpu?: boolean;
    requireSandbox?: boolean;
}

/**
 * Select the optimal cluster for an execution based on requirements and load.
 */
export async function selectOptimalCluster(
    prisma: PrismaClient,
    organizationId: string,
    agentConfig: Partial<AgentConfig>,
    preferences?: SelectionPreferences
): Promise<Cluster> {
    // Find candidate clusters in the organization
    const clusters = await prisma.cluster.findMany({
        where: {
            organizationId,
            status: 'ACTIVE',
        },
    });

    if (clusters.length === 0) {
        throw new Error('No connected clusters available. Please connect a cluster or use hosted execution.');
    }

    // Filter clusters by requirements
    const eligible = filterEligibleClusters(clusters, agentConfig, preferences);

    if (eligible.length === 0) {
        throw new Error('No clusters meet the resource requirements for this agent.');
    }

    // Score and rank eligible clusters
    const scored = await scoreClusters(eligible, preferences);

    // Select the highest-scored cluster
    const selected = scored[0].cluster;

    logger.info({
        clusterId: selected.id,
        clusterName: selected.name,
        score: scored[0].score,
        organizationId,
    }, 'Cluster selected for execution');

    return selected;
}

/**
 * Filter clusters by resource and capability requirements.
 */
function filterEligibleClusters(
    clusters: Cluster[],
    agentConfig: Partial<AgentConfig>,
    preferences?: SelectionPreferences
): Cluster[] {
    return clusters.filter(cluster => {
        const capabilities = cluster.capabilities as any as ClusterCapabilities;

        // Check GPU requirement
        if (preferences?.requireGpu || agentConfig.resources?.gpu) {
            if (capabilities.resources.gpuNodes === 0) {
                logger.debug({ clusterId: cluster.id, reason: 'no_gpu_nodes' }, 'Cluster filtered out');
                return false;
            }
        }

        // Check Agent Sandbox requirement
        if (preferences?.requireSandbox || agentConfig.useAgentSandbox) {
            const hasAgentSandbox = (capabilities as any).features?.agentSandbox === true;
            if (!hasAgentSandbox) {
                logger.debug({ clusterId: cluster.id, reason: 'no_agent_sandbox' }, 'Cluster filtered out');
                return false;
            }
        }

        return true;
    });
}

/**
 * Score clusters based on load, health, and preferences.
 */
async function scoreClusters(
    clusters: Cluster[],
    preferences?: SelectionPreferences
): Promise<Array<{ cluster: Cluster; score: number }>> {
    const workQueue = getWorkQueue();
    const scored: Array<{ cluster: Cluster; score: number }> = [];

    for (const cluster of clusters) {
        let score = 100;

        // Factor 1: Queue depth
        const queueLength = await workQueue.getQueueLength(cluster.organizationId, cluster.id);
        const queuePenalty = Math.min(queueLength * 5, 50);
        score -= queuePenalty;

        // Factor 2: Heartbeat recency
        const lastHeartbeat = cluster.lastHeartbeat ? new Date(cluster.lastHeartbeat).getTime() : 0;
        const heartbeatAge = Date.now() - lastHeartbeat;
        const ageMinutes = heartbeatAge / (1000 * 60);
        if (ageMinutes > 5) {
            score -= Math.min(ageMinutes * 2, 20);
        } else if (lastHeartbeat === 0) {
            score -= 10;
        }

        // Factor 3: Region preference
        if (preferences?.preferredRegion) {
            const capabilities = cluster.capabilities as any as ClusterCapabilities;
            if (capabilities.region === preferences.preferredRegion) {
                score += 20;
            }
        }

        // Factor 4: Random jitter
        score += Math.random() * 10;

        scored.push({ cluster, score });
    }

    scored.sort((a, b) => b.score - a.score);

    logger.debug({
        scores: scored.map(s => ({
            clusterId: s.cluster.id,
            clusterName: s.cluster.name,
            score: s.score.toFixed(2),
        })),
    }, 'Cluster scores calculated');

    return scored;
}
