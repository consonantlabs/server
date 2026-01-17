/**
 * @fileoverview Cluster Controller
 * @module controllers/clusters
 * 
 * Handles cluster management operations:
 * - Register new clusters
 * - List organization's clusters
 * - Get cluster details
 * - Update cluster status
 * - Delete clusters
 * 
 * IMPORTANT: Clusters authenticate via cluster secrets (NOT API keys).
 * Cluster secrets are separate from REST API keys and used only for gRPC connections.
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import { generateSecureToken, hashSecret } from '@/utils/crypto.js';
import { SECURITY } from '@/config/constants.js';
import { logger } from '@/utils/logger.js';

/**
 * Request body for registering a cluster.
 */
interface RegisterClusterBody {
  name: string;
  namespace?: string;
}

/**
 * URL parameters for cluster routes.
 */
interface ClusterParams {
  organizationId: string;
  clusterId?: string;
}

/**
 * Register a new cluster with the control plane.
 * 
 * POST /api/v1/organizations/:organizationId/clusters
 * 
 * FLOW:
 * 1. Validate cluster name is unique within organization
 * 2. Generate secure cluster secret
 * 3. Hash the secret with bcrypt
 * 4. Create cluster record in database
 * 5. Return cluster ID and secret (ONE-TIME VIEW)
 * 
 * The returned cluster secret is used by the relayer to authenticate
 * gRPC connections to: consonantlabs.xyz/{orgId}/stream
 * 
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function registerCluster(
  request: FastifyRequest<{
    Params: ClusterParams;
    Body: RegisterClusterBody;
  }>,
  reply: FastifyReply
): Promise<void> {
  const { organizationId } = request.params;
  const { name, namespace = 'default' } = request.body;

  logger.info(
    {
      organizationId,
      name,
      namespace,
    },
    'Registering cluster'
  );

  try {
    // Validate organization exists
    const organization = await request.prisma.organization.findUnique({
      where: { id: organizationId },
    });

    if (!organization) {
      reply.code(404).send({
        success: false,
        error: 'Organization not found',
      });
      return;
    }

    // Check if cluster name already exists in this organization
    const existingCluster = await request.prisma.cluster.findFirst({
      where: {
        organizationId,
        name,
      },
    });

    if (existingCluster) {
      reply.code(409).send({
        success: false,
        error: 'Cluster with this name already exists in this organization',
      });
      return;
    }

    // Generate secure cluster secret
    const clusterSecret = generateSecureToken(SECURITY.MIN_CLUSTER_SECRET_LENGTH);
    logger.debug('Generated cluster secret');

    // Hash the secret for storage
    const secretHash = await hashSecret(clusterSecret);
    logger.debug('Hashed cluster secret');

    // Create cluster in database
    const cluster = await request.prisma.cluster.create({
      data: {
        organizationId,
        name,
        namespace,
        secretHash,
        capabilities: {},
        status: 'PENDING', // Will become ACTIVE when gRPC connects
      },
    });

    logger.info(
      {
        clusterId: cluster.id,
        organizationId,
        name,
      },
      'Cluster registered successfully'
    );

    // Return cluster details with plaintext secret (ONLY TIME IT'S SHOWN)
    reply.code(201).send({
      success: true,
      data: {
        id: cluster.id,
        name: cluster.name,
        namespace: cluster.namespace,
        secret: clusterSecret, // ⚠️ PLAINTEXT - show only once
        status: cluster.status,
        connectionEndpoint: `consonantlabs.xyz/${organizationId}/stream`,
        createdAt: cluster.createdAt.toISOString(),
      },
      message: 'Cluster registered. Configure your relayer with this secret - it will not be shown again.',
    });
  } catch (error) {
    logger.error(
      {
        err: error,
        organizationId,
        name,
      },
      'Failed to register cluster'
    );

    reply.code(500).send({
      success: false,
      error: 'Failed to register cluster',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * List all clusters for an organization.
 * 
 * GET /api/v1/organizations/:organizationId/clusters
 * 
 * Returns cluster metadata including connection status.
 * 
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function listClusters(
  request: FastifyRequest<{ Params: ClusterParams }>,
  reply: FastifyReply
): Promise<void> {
  const { organizationId } = request.params;

  logger.debug(
    {
      organizationId,
    },
    'Listing clusters'
  );

  try {
    const clusters = await request.prisma.cluster.findMany({
      where: {
        organizationId,
      },
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
      orderBy: {
        createdAt: 'desc',
      },
    });

    reply.send({
      success: true,
      data: clusters.map(cluster => ({
        ...cluster,
        lastHeartbeat: cluster.lastHeartbeat?.toISOString() || null,
        createdAt: cluster.createdAt.toISOString(),
        updatedAt: cluster.updatedAt.toISOString(),
      })),
      meta: {
        total: clusters.length,
        active: clusters.filter(c => c.status === 'ACTIVE').length,
      },
    });
  } catch (error) {
    logger.error(
      {
        err: error,
        organizationId,
      },
      'Failed to list clusters'
    );

    reply.code(500).send({
      success: false,
      error: 'Failed to list clusters',
    });
  }
}

/**
 * Get detailed information about a specific cluster.
 * 
 * GET /api/v1/organizations/:organizationId/clusters/:clusterId
 * 
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function getCluster(
  request: FastifyRequest<{ Params: ClusterParams }>,
  reply: FastifyReply
): Promise<void> {
  const { organizationId, clusterId } = request.params;

  logger.debug(
    {
      organizationId,
      clusterId,
    },
    'Getting cluster details'
  );

  try {
    const cluster = await request.prisma.cluster.findFirst({
      where: {
        id: clusterId,
        organizationId,
      },
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

    if (!cluster) {
      reply.code(404).send({
        success: false,
        error: 'Cluster not found',
      });
      return;
    }

    reply.send({
      success: true,
      data: {
        ...cluster,
        lastHeartbeat: cluster.lastHeartbeat?.toISOString() || null,
        createdAt: cluster.createdAt.toISOString(),
        updatedAt: cluster.updatedAt.toISOString(),
      },
    });
  } catch (error) {
    logger.error(
      {
        err: error,
        organizationId,
        clusterId,
      },
      'Failed to get cluster'
    );

    reply.code(500).send({
      success: false,
      error: 'Failed to get cluster',
    });
  }
}

/**
 * Delete a cluster.
 * 
 * DELETE /api/v1/organizations/:organizationId/clusters/:clusterId
 * 
 * This also closes any active gRPC connections and deletes associated telemetry data.
 * 
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function deleteCluster(
  request: FastifyRequest<{ Params: ClusterParams }>,
  reply: FastifyReply
): Promise<void> {
  const { organizationId, clusterId } = request.params;

  logger.info(
    {
      organizationId,
      clusterId,
    },
    'Deleting cluster'
  );

  try {
    // Verify cluster exists
    const cluster = await request.prisma.cluster.findFirst({
      where: {
        id: clusterId,
        organizationId,
      },
    });

    if (!cluster) {
      reply.code(404).send({
        success: false,
        error: 'Cluster not found',
      });
      return;
    }

    // TODO: Close gRPC connection if active
    // if (cluster.socketId) {
    //   await grpcServer.closeConnection(cluster.socketId);
    // }

    // Delete cluster (cascade will delete telemetry data)
    await request.prisma.cluster.delete({
      where: {
        id: clusterId,
      },
    });

    logger.info(
      {
        clusterId,
        organizationId,
      },
      'Cluster deleted successfully'
    );

    reply.send({
      success: true,
      message: 'Cluster deleted successfully',
    });
  } catch (error) {
    logger.error(
      {
        err: error,
        organizationId,
        clusterId,
      },
      'Failed to delete cluster'
    );

    reply.code(500).send({
      success: false,
      error: 'Failed to delete cluster',
    });
  }
}