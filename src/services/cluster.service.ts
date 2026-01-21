/**
 * @fileoverview Cluster Selection Service
 * @module services/cluster
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
import { getWorkQueue } from './redis/work-queue.js';
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
   */
  async selectCluster(
    organizationId: string,
    agentConfig: Partial<AgentConfig>,
    preferences?: SelectionPreferences
  ): Promise<Cluster> {
    const { selectOptimalCluster } = await import('./cluster/selection.js');
    return selectOptimalCluster(this.prisma, organizationId, agentConfig, preferences);
  }

  /**
   * Get statistics about cluster availability and load.
   * 
   * Returns a summary of all clusters showing their status and queue depth.
   * Useful for monitoring and debugging cluster selection.
   * 
   * @param organizationId - Which organization's clusters to check
   * @returns Array of cluster stats including queue depth and last heartbeat
   */
  async getClusterStats(organizationId: string): Promise<Array<{
    id: string;
    name: string;
    status: string;
    queueDepth: number;
    lastHeartbeat: Date | null;
    capabilities: ClusterCapabilities;
  }>> {
    const clusters = await this.prisma.cluster.findMany({
      where: { organizationId },
    });

    const workQueue = getWorkQueue();
    const stats = [];

    for (const cluster of clusters) {
      const queueDepth = await workQueue.getQueueLength(cluster.organizationId, cluster.id);

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
  /**
   * Register or update a cluster.
   * 
   * NEW ARCHITECTURE (2-Phase Auth):
   * 1. Relayer calls with API Key.
   * 2. Server generates a new Cluster Secret.
   * 3. Server returns plaintext secret (one-time).
   * 4. Relayer stores secret and uses it for all subsequent gRPC calls.
   * 
   * @param data - Cluster registration details
   * @returns The registered cluster record and the plaintext secret
   */
  async registerCluster(data: {
    organizationId: string;
    apiKeyId: string;
    name: string;
    relayerVersion?: string;
    capabilities?: any;
  }): Promise<{ cluster: Cluster; clusterSecret: string }> {
    const { generateSecureToken, hashSecret } = await import('../utils/crypto.js');

    // Generate a new secure cluster secret
    const clusterSecret = generateSecureToken(32);
    const secretHash = await hashSecret(clusterSecret);

    const cluster = await this.prisma.cluster.upsert({
      where: {
        organizationId_name: {
          organizationId: data.organizationId,
          name: data.name,
        }
      },
      update: {
        lastHeartbeat: new Date(),
        relayerVersion: data.relayerVersion,
        capabilities: data.capabilities ?? {},
        status: 'ACTIVE',
        apiKeyId: data.apiKeyId,
        secretHash, // Rotate secret on every registration for extra security
      },
      create: {
        organizationId: data.organizationId,
        name: data.name,
        relayerVersion: data.relayerVersion,
        capabilities: data.capabilities ?? {},
        status: 'ACTIVE',
        apiKeyId: data.apiKeyId,
        secretHash,
      },
    });

    return { cluster, clusterSecret };
  }

  /**
   * List all clusters for an organization.
   */
  async listClusters(organizationId: string) {
    return this.prisma.cluster.findMany({
      where: { organizationId },
      select: {
        id: true,
        name: true,
        namespace: true,
        status: true,
        lastHeartbeat: true,
        relayerVersion: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Get a specific cluster.
   */
  async getCluster(organizationId: string, clusterId: string) {
    return this.prisma.cluster.findFirst({
      where: { id: clusterId, organizationId },
      select: {
        id: true,
        name: true,
        namespace: true,
        status: true,
        lastHeartbeat: true,
        relayerVersion: true,
        relayerConfig: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  /**
   * Delete a cluster and close its active stream fleet-wide.
   */
  async deleteCluster(organizationId: string, clusterId: string): Promise<void> {
    try {
      // 1. Close active gRPC stream fleet-wide (via Redis signaling)
      const { getConnectionManager } = await import('./grpc/connection-manager.js');
      const manager = getConnectionManager();
      await manager.unregisterStream(clusterId);

      // 2. Clear work queue (multi-tenant partitioned)
      const { getWorkQueue } = await import('./redis/work-queue.js');
      await getWorkQueue().clearClusterQueue(organizationId, clusterId);

      // 3. Delete from DB
      await this.prisma.cluster.delete({
        where: { id: clusterId, organizationId }
      });

      logger.info({ organizationId, clusterId }, 'Cluster deleted and connection closed');
    } catch (error) {
      logger.error({ error, organizationId, clusterId }, 'Failed to delete cluster');
      throw error;
    }
  }

  /**
   * Update cluster heartbeat and status.
   */
  async updateHeartbeat(clusterId: string, statusText: string = 'ACTIVE'): Promise<void> {
    await this.prisma.cluster.update({
      where: { id: clusterId },
      data: {
        lastHeartbeat: new Date(),
        status: statusText as any
      }
    });
  }

  /**
   * Get single cluster statistics (Optimized).
   */
  async getSingleClusterStats(organizationId: string, clusterId: string) {
    const { getWorkQueue } = await import('./redis/work-queue.js');
    const queueLength = await getWorkQueue().getQueueLength(organizationId, clusterId);

    return {
      queueLength,
    };
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