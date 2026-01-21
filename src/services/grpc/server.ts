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
import { getWorkQueue } from '../redis/work-queue.js';
import { verifySecret } from '../../utils/crypto.js';
import { getConnectionManager } from './connection-manager.js';
import { getEventHandler } from './handlers/event-handler.js';
import { getClusterService } from '../cluster.service.js';
import { authInterceptor } from './interceptors/auth-interceptor.js';
import { loggingInterceptor } from './interceptors/logging-interceptor.js';
import { errorInterceptor } from './interceptors/error-interceptor.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Connection management is handled by ConnectionManager singleton

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
    // 1. Authenticate API key
    const keyPrefix = apiKey.substring(3, 11);
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



    // 3. Register/Update Cluster via Service
    const { cluster, clusterSecret } = await clusterService.registerCluster({
      organizationId: validKey.organizationId,
      apiKeyId: validKey.id,
      name: cluster_name,
      relayerVersion: relayer_version,
      capabilities: capabilities ? JSON.parse(JSON.stringify(capabilities)) : {},
    });

    logger.info({ clusterId: cluster.id }, 'Cluster registered successfully');

    callback(null, {
      success: true,
      cluster_id: cluster.id,
      message: 'Registration successful. STORE THIS SECRET - it is only shown once.',
      config_json: JSON.stringify({
        heartbeat_interval_ms: 30000,
        log_level: 'info',
        cluster_secret: clusterSecret, // The one-time plaintext secret
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
      } else if (message.agent_registration_status) {
        await getEventHandler().handleRegistrationStatus(clusterId, message.agent_registration_status);
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

  /**
   * ARCHITECTURAL DESIGN: Queue Message Mapping
   * We pull unified QueueMessages from Redis and map them to specific 
   * gRPC fields in the ControlPlaneMessage union.
   */
  const pushWork = async () => {
    if (!connectionManager.isConnected(clusterId)) return;

    try {
      const message = await workQueue.dequeue(organizationId, clusterId, 5);

      if (message && connectionManager.isConnected(clusterId)) {
        if (message.type === 'WORK') {
          await connectionManager.sendToCluster(clusterId, {
            work_item: {
              execution_id: message.data.executionId,
              agent_name: message.data.agentName,
              input_json: JSON.stringify(message.data.input),
              // Map to proto Priority enum if needed
              priority: message.data.priority === 'high' ? 1 : 2,
            }
          });
        } else if (message.type === 'REGISTRATION') {
          await connectionManager.sendToCluster(clusterId, {
            agent_registration: {
              name: message.data.agentName,
              image: message.data.image,
              resources: message.data.resources,
              retry_policy: message.data.retryPolicy,
              use_agent_sandbox: message.data.useAgentSandbox,
              warm_pool_size: message.data.warmPoolSize,
              network_policy: message.data.networkPolicy,
              environment_variables_json: JSON.stringify(message.data.environmentVariables || {}),
              config_hash: message.data.configHash,
              id: message.data.agentId,
            }
          });
        }

        // Recurse to check for more work immediately
        setImmediate(pushWork);
      } else if (connectionManager.isConnected(clusterId)) {
        // No work, wait a bit then check again
        setTimeout(pushWork, 100);
      }
    } catch (err) {
      logger.error({ err, clusterId }, 'Queue pusher error');
      setTimeout(pushWork, 1000);
    }
  };

  pushWork();
}

// Helper for mapping status enums is now in EventHandler

/**
 * Start the gRPC server.
 * 
 * ARCHITECTURAL DESIGN: Non-Blocking Initialization
 * We use bindAsync which is the modern, non-blocking way to start the gRPC
 * server. server.start() is deprecated in newer @grpc/grpc-js versions.
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
      grpc.ServerCredentials.createInsecure(), // TLS termination handled by LB
      (err, port) => {
        if (err) {
          logger.error({ err }, 'Failed to bind gRPC server');
          return reject(err);
        }
        logger.info({ port }, '✓ gRPC server listening');
        resolve();
      }
    );
  });
}