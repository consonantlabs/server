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
import { inngest } from '../inngest/client.js';
import { verifySecret } from '../../utils/crypto.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Active stream tracking.
 * Maps cluster ID to the active bidirectional stream for that cluster.
 */
const activeStreams = new Map<string, grpc.ServerDuplexStream<any, any>>();

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
 */
async function registerCluster(
  call: grpc.ServerUnaryCall<any, any>,
  callback: grpc.sendUnaryData<any>
) {
  const { api_key, cluster_id, cluster_name, relayer_version, capabilities } = call.request;

  logger.info({
    clusterId: cluster_id,
    clusterName: cluster_name,
    relayerVersion: relayer_version,
  }, 'Cluster registration request received');

  try {
    const prisma = await prismaManager.getClient();
    // 1. Authenticate API key
    const keyPrefix = api_key.substring(0, 8);
    const apiKeys = await prisma.apiKey.findMany({
      where: { keyPrefix, revokedAt: null }
    });

    let validKey = null;
    for (const key of apiKeys) {
      if (await verifySecret(api_key, key.keyHash)) {
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

    // 2. Register/Update Cluster
    const cluster = await prisma.cluster.upsert({
      where: {
        organizationId_name: {
          organizationId: validKey.organizationId,
          name: cluster_name,
        }
      },
      update: {
        lastHeartbeat: new Date(),
        relayerVersion: relayer_version,
        capabilities: capabilities ? JSON.parse(JSON.stringify(capabilities)) : {},
        status: 'ACTIVE',
        apiKeyId: validKey.id, // Link to API Key
      },
      create: {
        organizationId: validKey.organizationId,
        name: cluster_name,
        relayerVersion: relayer_version,
        capabilities: capabilities ? JSON.parse(JSON.stringify(capabilities)) : {},
        secretHash: await import('../../utils/crypto.js').then(m => m.hashSecret(cluster_id)), // Initial secret is cluster_id
        status: 'ACTIVE',
        apiKeyId: validKey.id, // Link to API Key
      },
    });

    // TODO: In production, we should return the generated secret to the relayer here
    // But currently the proto definition might not support it, or we expect it pre-shared.
    // For now, we satisfy the DB requirement.

    logger.info({ clusterId: cluster.id }, 'Cluster registered successfully');

    callback(null, {
      success: true,
      cluster_id: cluster.id,
      message: 'Registration successful',
      config_json: JSON.stringify({
        heartbeat_interval_ms: 30000,
        log_level: 'info'
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
async function streamWork(call: grpc.ServerDuplexStream<any, any>) {
  // Extract metadata (auth)
  const metadata = call.metadata;
  const apiKey = metadata.get('x-api-key')[0] as string;
  const clusterId = metadata.get('x-cluster-id')[0] as string;
  const workQueue = getWorkQueue();

  // 1. Verify API Key and Cluster Ownership
  try {
    const prisma = await prismaManager.getClient();
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
      logger.warn({ clusterId }, 'Stream rejected: Invalid API key');
      call.end();
      return;
    }

    // Ensure cluster belongs to the API key's organization
    const cluster = await prisma.cluster.findFirst({
      where: { id: clusterId, organizationId: validKey.organizationId }
    });

    if (!cluster) {
      logger.warn({ clusterId, orgId: validKey.organizationId }, 'Stream rejected: Cluster not found or access denied');
      call.end();
      return;
    }

    logger.info({ clusterId, orgId: validKey.organizationId }, 'Relayer connected via stream');

    // Update status to ACTIVE
    await prisma.cluster.update({
      where: { id: clusterId },
      data: { status: 'ACTIVE', lastHeartbeat: new Date() }
    });

  } catch (err) {
    logger.error({ err, clusterId }, 'Stream authentication error');
    call.end();
    return;
  }

  // Register stream
  activeStreams.set(clusterId, call);

  // Handle incoming messages (Status updates, Logs)
  call.on('data', async (message: any) => {
    try {
      if (message.heartbeat) {
        // Update heartbeat
        // We could optimize this to not hit DB every time
        const prisma = await prismaManager.getClient();
        await prisma.cluster.updateMany({
          where: { id: clusterId },
          data: { lastHeartbeat: new Date(message.heartbeat.timestamp) }
        });

        // Trigger Inngest heartbeat event
        inngest.send({
          name: 'cluster.heartbeat',
          data: {
            clusterId,
            status: message.heartbeat.status,
            heartbeatAt: new Date().toISOString()
          }
        });
      } else if (message.execution_status) {
        // Forward to Inngest for processing
        const status = message.execution_status;
        const eventName = getStatusEventName(status.status);

        if (eventName) {
          await inngest.send({
            name: eventName,
            data: {
              executionId: status.execution_id,
              clusterId: status.cluster_id,
              status: status.status,
              ...status.started_details, // Spread details if any
              ...status.completed_details,
              ...status.failed_details
            }
          });
        }
      }
      // Handle logs, metrics, traces...
    } catch (err) {
      logger.error({ err, clusterId }, 'Error processing stream message');
    }
  });

  call.on('end', () => {
    logger.info({ clusterId }, 'Relayer disconnected');
    activeStreams.delete(clusterId);
  });

  call.on('error', (err) => {
    logger.error({ err, clusterId }, 'Stream error');
    activeStreams.delete(clusterId);
  });

  // Start Work Pusher for this cluster
  // We poll Redis queue specifically for this cluster
  const pollInterval = setInterval(async () => {
    // Stop if stream is closed
    if (!activeStreams.has(clusterId)) {
      clearInterval(pollInterval);
      return;
    }

    try {
      // Pop work from Redis (non-blocking or short timeout)
      const workItem = await workQueue.dequeue(clusterId);

      if (workItem) {
        logger.info({
          clusterId,
          executionId: workItem.executionId
        }, 'Pushing work to relayer');

        // Write to gRPC stream
        // Write to gRPC stream with full proto mapping
        call.write({
          work_item: {
            execution_id: workItem.executionId,
            agent_id: workItem.agentId,
            agent_name: workItem.agentName,
            agent_image: workItem.agentImage,
            input_json: JSON.stringify(workItem.input),
            resources: workItem.resources, // Proto match: cpu, memory, gpu, timeout
            retry_policy: {
              max_attempts: workItem.retryPolicy.maxAttempts,
              backoff: workItem.retryPolicy.backoff,
              initial_delay: workItem.retryPolicy.initialDelay || '1s'
            },
            use_agent_sandbox: workItem.useAgentSandbox,
            warm_pool_size: workItem.warmPoolSize,
            network_policy: workItem.networkPolicy,
            environment_variables_json: JSON.stringify(workItem.environmentVariables || {})
          }
        });
      }
    } catch (err) {
      logger.error({ err, clusterId }, 'Error polling/pushing work');
    }
  }, 100); // Check every 100ms - high responsiveness
}

function getStatusEventName(statusEnum: any): any {
  // Map proto enum to event name
  switch (statusEnum) {
    case 'STATUS_RUNNING': return 'agent.execution.started';
    case 'STATUS_COMPLETED': return 'agent.execution.completed';
    case 'STATUS_FAILED': return 'agent.execution.failed';
    default: return null;
  }
}

/**
 * Start the gRPC server.
 */
export async function startGrpcServer(port: number) {
  const proto = loadProtoDefinition();
  const server = new grpc.Server();

  server.addService(proto.ConsonantControlPlane.service, {
    RegisterCluster: registerCluster,
    StreamWork: streamWork,
  });

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