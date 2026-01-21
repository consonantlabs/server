/**
 * @fileoverview Cluster Controller
 * @module controllers/clusters
 * 
 * Handles cluster management operations via REST API.
 * Delegates business logic to ClusterService.
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import { getClusterService } from '../services/cluster.service.js';
import { logger } from '../utils/logger.js';

/**
 * Request parameters for cluster routes.
 */
interface ClusterParams {
  organizationId: string;
  clusterId?: string;
}

/**
 * Request body for registering a cluster.
 */
interface RegisterClusterBody {
  name: string;
  namespace?: string;
  apiKeyId: string;
}

/**
 * Register a new cluster (REST Entry Point).
 * 
 * POST /api/v1/organizations/:organizationId/clusters
 */
export async function registerCluster(
  request: FastifyRequest<{ Params: ClusterParams; Body: RegisterClusterBody }>,
  reply: FastifyReply
): Promise<void> {
  const { organizationId } = request.params;
  const { name, apiKeyId } = request.body;

  try {
    const service = getClusterService();
    const { cluster, clusterSecret } = await service.registerCluster({
      organizationId,
      apiKeyId,
      name,
    });

    return reply.code(201).send({
      success: true,
      data: {
        id: cluster.id,
        name: cluster.name,
        secret: clusterSecret,
        status: cluster.status,
      },
      message: 'Cluster registered successfully. Store the secret safely.',
    });
  } catch (error: any) {
    logger.error({ error, organizationId, name }, 'Failed to register cluster');
    return reply.code(500).send({ 
      success: false, 
      error: 'Failed to register cluster', 
      message: error.message 
    });
  }
}

/**
 * List clusters for an organization.
 * 
 * GET /api/v1/organizations/:organizationId/clusters
 */
export async function listClusters(
  request: FastifyRequest<{ Params: ClusterParams }>,
  reply: FastifyReply
): Promise<void> {
  const { organizationId } = request.params;

  try {
    const service = getClusterService();
    const clusters = await service.listClusters(organizationId);

    return reply.send({
      success: true,
      data: clusters,
    });
  } catch (error: any) {
    logger.error({ error, organizationId }, 'Failed to list clusters');
    return reply.code(500).send({ 
      success: false, 
      error: 'Failed to list clusters' 
    });
  }
}

/**
 * Get detailed cluster information including stats.
 * 
 * GET /api/v1/organizations/:organizationId/clusters/:clusterId
 */
export async function getCluster(
  request: FastifyRequest<{ Params: ClusterParams }>,
  reply: FastifyReply
): Promise<void> {
  const { organizationId, clusterId } = request.params;

  try {
    const service = getClusterService();
    const cluster = await service.getCluster(organizationId, clusterId!);

    if (!cluster) {
      return reply.code(404).send({ success: false, error: 'Cluster not found' });
    }

    const { queueLength } = await service.getSingleClusterStats(organizationId, clusterId!);

    return reply.send({
      success: true,
      data: {
        ...cluster,
        stats: { queueLength },
      },
    });
  } catch (error: any) {
    logger.error({ error, organizationId, clusterId }, 'Failed to get cluster');
    return reply.code(500).send({ success: false, error: 'Internal server error' });
  }
}

/**
 * Delete a cluster.
 * 
 * DELETE /api/v1/organizations/:organizationId/clusters/:clusterId
 */
export async function deleteCluster(
  request: FastifyRequest<{ Params: ClusterParams }>,
  reply: FastifyReply
): Promise<void> {
  const { organizationId, clusterId } = request.params;

  try {
    const service = getClusterService();
    await service.deleteCluster(organizationId, clusterId!);

    return reply.send({
      success: true,
      message: 'Cluster deleted successfully',
    });
  } catch (error: any) {
    logger.error({ error, organizationId, clusterId }, 'Failed to delete cluster');
    const statusCode = error.message.includes('not found') ? 404 : 500;
    return reply.code(statusCode).send({
      success: false,
      error: error.message || 'Operation failed',
    });
  }
}