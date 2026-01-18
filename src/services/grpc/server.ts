/**
 * @fileoverview gRPC Server Implementation
 * @module grpc/server
 * 
 * This is the communication bridge between the control plane and Kubernetes
 * relayers. Relayers establish persistent bidirectional streams that enable:
 * 
 * - Instant work distribution (control plane -> relayer)
 * - Real-time status updates (relayer -> control plane)
 */

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../../utils/logger.js';
import { prismaManager } from '../db/manager.js';
import { getWorkQueue } from '../redis/queue.js';
import { generateSecureToken, hashSecret, verifySecret } from '../../utils/crypto.js';
import { getConnectionManager } from './connection-manager.js';
import { getEventHandler } from './handlers/event-handler.js';
import { getClusterService } from '../cluster.selection.js';
import { authInterceptor } from './interceptors/auth-interceptor.js';
import { loggingInterceptor } from './interceptors/logging-interceptor.js';
import { errorInterceptor } from './interceptors/error-interceptor.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Connection management is now handled by ConnectionManager singleton

/**
 * Load and compile the Protocol Buffer definitions.
 */
function loadProtoDefinition() {
  const PROTO_PATH = path.join(__dirname, '../../../proto/cluster_stream.proto');

  const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });

  const protoDescriptor = grpc.loadPackageDefinition(packageDefinition);
  return (protoDescriptor.consonant as any).v1;
}

/**
 * Register a Kubernetes cluster.
 * 
 * Protected by API Key (via AuthInterceptor and internal validation).
 */
async function registerCluster(
  call: grpc.ServerUnaryCall<any, any>,
  callback: grpc.sendUnaryData<any>
) {
  // Extract credentials - try metadata first (normalized), then payload
  const metadataApiKey = call.metadata.get('x-api-key')[0] as string | undefined;
  const { api_key: payloadApiKey, cluster_id, cluster_name, relayer_version, capabilities } = call.request;

  const apiKey = metadataApiKey || payloadApiKey;
  const clusterService = getClusterService();

  if (!apiKey) {
    return callback({
      code: grpc.status.UNAUTHENTICATED,
      details: 'API Key missing in metadata or payload',
    });
  }

  logger.info({
    clusterId: cluster_id,
    clusterName: cluster_name,
    relayerVersion: relayer_version,
  }, 'Cluster registration request received');

  try {
    const prisma = await prismaManager.getClient();
    // 1. Authenticate API key (Brutal re-verification for high security)
    const keyPrefix = apiKey.substring(0, 8);
    const apiKeys = await prisma.apiKey.findMany({
      where: { keyPrefix, revokedAt: null }
    });

    let validKey = null;
    for (const key of apiKeys) {
      if (await verifySecret(apiKey, key.keyHash)) {
        validKey = key;
        break;
      }
    }

    if (!validKey) {
      return callback({
        code: grpc.status.UNAUTHENTICATED,
        details: 'Invalid API key',
      });
    }

    // 2. Generate secure cluster token (Used if we want multi-layer auth, 
    // but per user request we primarily rely on API Key now. 
    // We still store this for legacy compatibility or future use)
    const clusterToken = generateSecureToken(32);
    const secretHash = await hashSecret(clusterToken);

    // 3. Register/Update Cluster via Service
    const cluster = await clusterService.registerCluster({
      organizationId: validKey.organizationId,
      apiKeyId: validKey.id,
      name: cluster_name,
      relayerVersion: relayer_version,
      capabilities: capabilities ? JSON.parse(JSON.stringify(capabilities)) : {},
      secretHash: secretHash,
    });

    logger.info({ clusterId: cluster.id }, 'Cluster registered successfully');

    callback(null, {
      success: true,
      cluster_id: cluster.id,
      message: 'Registration successful',
      config_json: JSON.stringify({
        heartbeat_interval_ms: 30000,
        log_level: 'info',
        cluster_token: clusterToken // Provided in case the relayer wants to use it
      }),
    });
  } catch (error) {
    logger.error({ error, clusterId: cluster_id }, 'Registration failed');
    callback({
      code: grpc.status.INTERNAL,
      details: 'Registration failed',
    });
  }
}

/**
 * Handle bidirectional stream for work and status.
 */
/**
 * Handle bidirectional stream for work and telemetry (Primary Relayer Loop).
 * 
 * This is the "hot pipe" where:
 * 1. Control Plane pushes work items to Relayer
 * 2. Relayer pushes logs, metrics, and status back to Control Plane
 * 3. Heartbeats maintain connection liveness
 * 
 * @param call - The bidirectional gRPC stream
 */
async function streamWork(call: grpc.ServerDuplexStream<any, any>) {
  const clusterId = call.metadata.get('cluster-id')[0] as string;
  const connectionManager = getConnectionManager();
  const workQueue = getWorkQueue();

  // Stream is already authenticated by AuthInterceptor
  logger.info({ clusterId }, 'Relayer stream established');

  // Register stream with manager
  await connectionManager.registerStream(clusterId, call);

  // Update status to ACTIVE
  try {
    await getClusterService().updateHeartbeat(clusterId, 'ACTIVE');
  } catch (err) {
    logger.error({ err, clusterId }, 'Failed to update cluster status on connect');
  }

  // 1. Fetch cluster to get organizationId
  let organizationId = 'unknown';
  try {
    const prisma = await prismaManager.getClient();
    const cluster = await prisma.cluster.findUnique({
      where: { id: clusterId },
      select: { organizationId: true }
    });
    if (cluster) {
      organizationId = cluster.organizationId;
    }
  } catch (err) {
    logger.error({ err, clusterId }, 'Failed to fetch cluster organization for work pusher');
  }

  // Handle incoming messages
  call.on('data', async (message: any) => {
    try {
      if (message.heartbeat) {
        // Emit for real-time tracking
        await connectionManager.handleHeartbeat(clusterId);

        // Background DB update via service
        getClusterService().updateHeartbeat(clusterId).catch((e: Error) => {
          logger.error({ e, clusterId }, 'Heartbeat DB update failed');
        });
      } else if (message.execution_status) {
        await getEventHandler().handleExecutionStatus(clusterId, message.execution_status);
      } else if (message.log_batch) {
        await getEventHandler().handleLogBatch(clusterId, message.log_batch);
      } else if (message.metric_batch) {
        await getEventHandler().handleMetricBatch(clusterId, message.metric_batch);
      } else if (message.trace_batch) {
        await getEventHandler().handleTraceBatch(clusterId, message.trace_batch);
      }
    } catch (err) {
      logger.error({ err, clusterId }, 'Error processing stream message');
    }
  });

  call.on('end', async () => {
    logger.info({ clusterId }, 'Relayer stream closed by client');
    await connectionManager.unregisterStream(clusterId);
  });

  call.on('error', async (err) => {
    logger.error({ err, clusterId }, 'Stream error (cleanup triggered)');
    await connectionManager.unregisterStream(clusterId);
  });

  // Work Pusher - Using a more efficient approach
  // In Phase 2, we should move this to an event-driven listener on the ConnectionManager
  // but for immediate stability we keep a clean loop here.
  const pushWork = async () => {
    if (!connectionManager.isConnected(clusterId)) return;

    try {
      // Dequeue with partitioning
      const workItem = await workQueue.dequeue(organizationId, clusterId, 5);

      if (workItem && connectionManager.isConnected(clusterId)) {
        await connectionManager.sendToCluster(clusterId, {
          work_item: {
            execution_id: workItem.executionId,
            agent_id: workItem.agentId,
            agent_name: workItem.agentName,
            agent_image: workItem.agentImage,
            input_json: JSON.stringify(workItem.input),
            resources: workItem.resources,
            retry_policy: workItem.retryPolicy,
            use_agent_sandbox: workItem.useAgentSandbox,
            warm_pool_size: workItem.warmPoolSize,
            network_policy: workItem.networkPolicy,
            environment_variables_json: JSON.stringify(workItem.environmentVariables || {})
          }
        });

        // Recurse to check for more work immediately
        setImmediate(pushWork);
      } else if (connectionManager.isConnected(clusterId)) {
        // No work, wait a bit then check again
        setTimeout(pushWork, 100);
      }
    } catch (err) {
      logger.error({ err, clusterId }, 'Work pusher error');
      setTimeout(pushWork, 1000);
    }
  };

  pushWork();
}

// Helper for mapping status enums is now in EventHandler

/**
 * Start the gRPC server.
 */
export async function startGrpcServer(port: number, redisUrl: string) {
  const connectionManager = getConnectionManager();
  await connectionManager.init(redisUrl);

  const proto = loadProtoDefinition();
  const server = new grpc.Server();

  server.addService(proto.ConsonantControlPlane.service, {
    RegisterCluster: registerCluster,
    StreamWork: streamWork,
  });

  // Register interceptors for all calls
  (server as any).interceptors = [
    authInterceptor,
    loggingInterceptor,
    errorInterceptor,
  ];

  return new Promise<void>((resolve, reject) => {
    server.bindAsync(
      `0.0.0.0:${port}`,
      grpc.ServerCredentials.createInsecure(), // Use TLS in prod
      (err, port) => {
        if (err) return reject(err);
        logger.info({ port }, 'gRPC server bound');
        server.start(); // This method is deprecated in newer versions but valid in @grpc/grpc-js 1.9
        // server.start() is not needed in newest grpc-js, plain bindAsync is enough? 
        // Docs say: server.start() is required.
        resolve();
      }
    );
  });
}