/**
 * @fileoverview Cluster Selection Service
 * @module services/cluster-selection
 * 
 * This service implements the logic for choosing which Kubernetes cluster
 * should execute an agent. The selection considers resource requirements,
 * cluster capabilities, current load, and geographic preferences.
 * 
 * ARCHITECTURAL IMPORTANCE:
 * Good cluster selection is critical for performance and reliability.
 * We want to distribute load evenly, respect data locality requirements,
 * and ensure clusters have the resources agents need (especially GPUs).
 */

import { PrismaClient, Cluster } from '@prisma/client';
import { logger } from '../utils/logger.js';
import { getWorkQueue } from './redis/queue.js';
import type { AgentConfig } from './inngest/events.js';

/**
 * Cluster capabilities structure (stored as JSON in database).
 */
export interface ClusterCapabilities {
  kubernetes: {
    version: string;
    provider?: string; // aws, gcp, azure, etc
  };
  resources: {
    totalCpu: string;
    totalMemory: string;
    gpuNodes: number;
    gpuType?: string; // nvidia-tesla-v100, etc
  };
  region?: string;
  availabilityZone?: string;
}

/**
 * Selection preferences that can be passed when choosing a cluster.
 */
export interface SelectionPreferences {
  preferredRegion?: string; // Prefer clusters in this region
  requireGpu?: boolean;      // Must have GPU nodes
  requireSandbox?: boolean;  // Must support Agent Sandbox
}

/**
 * Cluster Selection Service
 * 
 * Chooses the optimal cluster for executing an agent based on
 * requirements, availability, and load distribution.
 */
export class ClusterService {
  constructor(private prisma: PrismaClient) { }

  /**
   * Select the best cluster for an execution.
   * 
   * The selection algorithm considers:
   * 1. Resource requirements (CPU, memory, GPU)
   * 2. Cluster connectivity (must be connected)
   * 3. Current queue depth (prefer less loaded clusters)
   * 4. Geographic preferences
   * 5. Load balancing across clusters
   * 
   * @param organizationId - Which organization's clusters to consider
   * @param agentConfig - Agent's resource requirements
   * @param preferences - Optional selection preferences
   * @returns Selected cluster
   * @throws Error if no suitable cluster is available
   */
  async selectCluster(
    organizationId: string,
    agentConfig: Partial<AgentConfig>,
    preferences?: SelectionPreferences
  ): Promise<Cluster> {
    try {
      // Find candidate clusters in the organization
      const clusters = await this.prisma.cluster.findMany({
        where: {
          organizationId,
          status: 'ACTIVE',
        },
      });

      if (clusters.length === 0) {
        throw new Error('No connected clusters available. Please connect a cluster or use hosted execution.');
      }

      // Filter clusters by requirements
      const eligible = this.filterEligibleClusters(
        clusters,
        agentConfig,
        preferences
      );

      if (eligible.length === 0) {
        throw new Error('No clusters meet the resource requirements for this agent.');
      }

      // Score and rank eligible clusters
      const scored = await this.scoreClusters(eligible, preferences);

      // Select the highest-scored cluster
      const selected = scored[0].cluster;

      logger.info({
        clusterId: selected.id,
        clusterName: selected.name,
        score: scored[0].score,
        organizationId,
      }, 'Cluster selected for execution');

      return selected;
    } catch (error) {
      logger.error({
        error,
        organizationId,
      }, 'Failed to select cluster');
      throw error;
    }
  }

  /**
   * Filter clusters to only those that meet the agent's requirements.
   * 
   * Eliminates clusters that don't have necessary resources or capabilities.
   * 
   * @param clusters - All available clusters
   * @param agentConfig - Agent's requirements
   * @param preferences - Optional preferences
   * @returns Filtered list of eligible clusters
   */
  private filterEligibleClusters(
    clusters: Cluster[],
    agentConfig: Partial<AgentConfig>,
    preferences?: SelectionPreferences
  ): Cluster[] {
    return clusters.filter(cluster => {
      const capabilities = cluster.capabilities as any as ClusterCapabilities;

      // Check GPU requirement
      if (preferences?.requireGpu || agentConfig.resources?.gpu) {
        if (capabilities.resources.gpuNodes === 0) {
          logger.debug({
            clusterId: cluster.id,
            reason: 'no_gpu_nodes',
          }, 'Cluster filtered out');
          return false;
        }
      }

      // Check Agent Sandbox requirement
      if (preferences?.requireSandbox || agentConfig.useAgentSandbox) {
        // Check if cluster has Agent Sandbox installed
        // This is indicated by the cluster's capabilities during registration
        const hasAgentSandbox = (capabilities as any).features?.agentSandbox === true;

        if (!hasAgentSandbox) {
          logger.debug({
            clusterId: cluster.id,
            reason: 'no_agent_sandbox',
          }, 'Cluster filtered out');
          return false;
        }
      }

      // Check region preference
      if (preferences?.preferredRegion) {
        if (capabilities.region !== preferences.preferredRegion) {
          // Don't filter out, but this will affect scoring
        }
      }

      // Cluster is eligible
      return true;
    });
  }

  /**
   * Score clusters based on multiple factors.
   * 
   * Returns clusters in descending score order (best first).
   * Scoring factors:
   * - Current queue depth (lower is better)
   * - Last heartbeat recency (more recent is better)
   * - Region match (matching preferred region is better)
   * - Round-robin to balance load
   * 
   * @param clusters - Eligible clusters to score
   * @param preferences - Optional preferences
   * @returns Array of scored clusters, sorted by score descending
   */
  private async scoreClusters(
    clusters: Cluster[],
    preferences?: SelectionPreferences
  ): Promise<Array<{ cluster: Cluster; score: number }>> {
    const workQueue = getWorkQueue();
    const scored: Array<{ cluster: Cluster; score: number }> = [];

    for (const cluster of clusters) {
      let score = 100; // Start with base score

      // Factor 1: Queue depth (heavily weighted)
      // Prefer clusters with shorter queues
      const queueLength = await workQueue.getQueueLength(cluster.id);
      const queuePenalty = Math.min(queueLength * 5, 50); // Cap at 50 points
      score -= queuePenalty;

      // Factor 2: Heartbeat recency (indicates cluster health)
      const lastHeartbeat = cluster.lastHeartbeat ? new Date(cluster.lastHeartbeat).getTime() : 0;
      const heartbeatAge = Date.now() - lastHeartbeat;
      const ageMinutes = heartbeatAge / (1000 * 60);
      if (ageMinutes > 5) {
        // Penalize clusters that haven't sent heartbeat recently
        score -= Math.min(ageMinutes * 2, 20);
      } else if (lastHeartbeat === 0) {
        // No heartbeat recorded yet - slight penalty
        score -= 10;
      }

      // Factor 3: Region preference
      if (preferences?.preferredRegion) {
        const capabilities = cluster.capabilities as any as ClusterCapabilities;
        if (capabilities.region === preferences.preferredRegion) {
          score += 20; // Bonus for region match
        }
      }

      // Factor 4: Random jitter for load balancing
      // When scores are close, this provides natural load distribution
      score += Math.random() * 10;

      scored.push({ cluster, score });
    }

    // Sort by score descending
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

  /**
   * Get statistics about cluster availability and load.
   * 
   * Returns a summary of all clusters showing their status and queue depth.
   * Useful for monitoring and debugging cluster selection.
   * 
   * @param apiKeyId - Which customer's clusters to check
   * @returns Array of cluster stats
   */
  async getClusterStats(apiKeyId: string): Promise<Array<{
    id: string;
    name: string;
    status: string;
    queueDepth: number;
    lastHeartbeat: Date | null;
    capabilities: ClusterCapabilities;
  }>> {
    const clusters = await this.prisma.cluster.findMany({
      where: { organizationId: apiKeyId },
    });

    const workQueue = getWorkQueue();
    const stats = [];

    for (const cluster of clusters) {
      const queueDepth = await workQueue.getQueueLength(cluster.id);

      stats.push({
        id: cluster.id,
        name: cluster.name,
        status: cluster.status,
        queueDepth,
        lastHeartbeat: cluster.lastHeartbeat,
        capabilities: cluster.capabilities as any as ClusterCapabilities,
      });
    }

    return stats;
  }
}

/**
 * Singleton instance of the cluster selection service.
 */
let clusterServiceInstance: ClusterService | null = null;

/**
 * Initialize the cluster service.
 * 
 * @param prisma - Prisma client instance
 */
export function initClusterService(prisma: PrismaClient): void {
  clusterServiceInstance = new ClusterService(prisma);
  logger.info('Cluster service initialized');
}

/**
 * Get the cluster service instance.
 * 
 * @returns ClusterService instance
 * @throws Error if not initialized
 */
export function getClusterService(): ClusterService {
  if (!clusterServiceInstance) {
    throw new Error('Cluster service not initialized. Call initClusterService() first.');
  }
  return clusterServiceInstance;
}