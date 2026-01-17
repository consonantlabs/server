/**
 * @fileoverview gRPC Server Implementation
 * @module grpc/server
 * 
 * This is the communication bridge between the control plane and Kubernetes
 * relayers. Relayers establish persistent bidirectional streams that enable:
 * 
 * - Instant work distribution (control plane -> relayer)
 * - Real-time status updates (relayer -> control plane)
 * - Live log streaming from running agents
 * - Heartbeat monitoring for cluster health
 * 
 * ARCHITECTURAL INSIGHT:
 * The bidirectional stream pattern means relayers initiate the connection
 * (outbound from customer cluster). This requires zero inbound firewall rules
 * on the customer side, which is critical for enterprise adoption.
 * 
 * The control plane pushes work to relayers as soon as it arrives in Redis,
 * giving microsecond-latency distribution. This is much faster than polling
 * and scales to thousands of concurrent relayer connections.
 */

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../../utils/logger.js';
import { prismaManager } from '../../services/db/manager.js';
import { getWorkQueue } from '../../services/redis/queue.js';
import { inngest } from '../../services/inngest/client.js';
import { verifySecret } from '../../utils/crypto.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Active stream tracking.
 * Maps cluster ID to the active bidirectional stream for that cluster.
 * This allows the work distribution loop to push work instantly when it
 * arrives in the Redis queue.
 */
const activeStreams = new Map<string, grpc.ServerDuplexStream<any, any>>();

/**
 * Load and compile the Protocol Buffer definitions.
 * This generates TypeScript types and runtime validation for all messages.
 */
function loadProtoDefinition() {
  const PROTO_PATH = path.join(__dirname, '../../proto/consonant.proto');

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
 * This RPC is called once when a relayer starts up. It validates the API key,
 * stores cluster metadata, and returns configuration for the relayer.
 * 
 * @param call - gRPC call containing ClusterInfo
 * @param callback - Response callback with ClusterRegistration
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
    // Authenticate the API key using prefix lookup for performance
    const keyPrefix = api_key.substring(0, 8);

    // Find keys with matching prefix
    const apiKeys = await prisma.apiKey.findMany({
      where: {
        keyPrefix,
        revokedAt: null,
      },
    });

    // Find matching key via secure comparison
    let apiKey = null;
    for (const key of apiKeys) {
      if (await verifySecret(api_key, key.keyHash)) {
        apiKey = key;
        break;
      }
    }

    if (!apiKey) {
      logger.warn({ clusterId: cluster_id, keyPrefix }, 'Invalid API key for cluster registration');
      callback({
        code: grpc.status.UNAUTHENTICATED,
        message: 'Invalid API key',
      });
      return;
    }

    // Check if cluster already exists
    const existingCluster = await prisma.cluster.findFirst({
      where: {
        id: cluster_id,
        organizationId: apiKey.organizationId,
      },
    });

    if (existingCluster) {
      // Update existing cluster
      await prisma.cluster.update({
        where: { id: cluster_id },
        data: {
          name: cluster_name,
          capabilities: capabilities as any,
          status: 'ACTIVE',
          lastHeartbeat: new Date(),
          relayerVersion: relayer_version,
        },
      });

      logger.info({ clusterId: cluster_id }, 'Existing cluster reconnected');
    } else {
      // Create new cluster
      await prisma.cluster.create({
        data: {
          id: cluster_id,
          organizationId: apiKey.organizationId,
          name: cluster_name,
          capabilities: capabilities as any,
          status: 'ACTIVE',
          lastHeartbeat: new Date(),
          relayerVersion: relayer_version,
          secretHash: '', // Should probably be provided or managed differently
        },
      });

      logger.info({ clusterId: cluster_id }, 'New cluster registered');
    }

    // Emit cluster connected event
    await inngest.send({
      name: 'cluster.connected',
      data: {
        clusterId: cluster_id,
        apiKeyId: apiKey.id,
        capabilities: capabilities as any,
        relayerVersion: relayer_version,
        connectedAt: new Date().toISOString(),
      },
    });

    // Return success with configuration
    callback(null, {
      success: true,
      cluster_id,
      message: 'Cluster registered successfully',
      config_json: JSON.stringify({
        heartbeatInterval: 30, // seconds
        logBatchSize: 100,
        metricBatchSize: 50,
      }),
    });
  } catch (error) {
    logger.error({ error, clusterId: cluster_id }, 'Cluster registration failed');
    callback({
      code: grpc.status.INTERNAL,
      message: `Registration failed: ${error}`,
    });
  } finally {
    // No disconnect needed for prismaManager
  }
}

/**
 * Bidirectional streaming for work distribution and status updates.
 * 
 * This is the main RPC that powers the entire system. The relayer calls this
 * once and keeps the stream open indefinitely. The control plane uses this
 * stream to push work items and receive status updates, logs, and metrics.
 * 
 * STREAM LIFECYCLE:
 * 1. Relayer opens stream
 * 2. Relayer sends heartbeats periodically
 * 3. Control plane pushes work when available
 * 4. Relayer sends status updates as agents run
 * 5. Relayer sends logs/traces/metrics in real-time
 * 6. On disconnect, control plane cleans up
 * 
 * @param call - Bidirectional stream
 */
function streamWork(call: grpc.ServerDuplexStream<any, any>) {
  let clusterId: string | null = null;
  let workDistributionInterval: NodeJS.Timeout | null = null;

  logger.info('New stream connection established');

  // Handle incoming messages from relayer
  call.on('data', async (message: any) => {
    try {
      if (message.heartbeat) {
        await handleHeartbeat(call, message.heartbeat);

        // Store cluster ID from first heartbeat
        if (!clusterId && message.heartbeat.cluster_id) {
          clusterId = message.heartbeat.cluster_id;
          activeStreams.set(clusterId as string, call);

          logger.info({ clusterId }, 'Cluster stream registered');

          // Start work distribution loop for this cluster
          startWorkDistribution(call, clusterId as string);
        }
      } else if (message.execution_status) {
        await handleExecutionStatus(message.execution_status);
      } else if (message.log_batch) {
        await handleLogBatch(message.log_batch);
      } else if (message.trace_batch) {
        await handleTraceBatch(message.trace_batch);
      } else if (message.metric_batch) {
        await handleMetricBatch(message.metric_batch);
      }
    } catch (error) {
      logger.error({ error, clusterId }, 'Error processing relayer message');
    }
  });

  // Handle stream end (graceful disconnect)
  call.on('end', async () => {
    logger.info({ clusterId }, 'Stream ended gracefully');
    await cleanupStream(clusterId, workDistributionInterval);
    call.end();
  });

  // Handle stream error (unexpected disconnect)
  call.on('error', async (error) => {
    logger.error({ error, clusterId }, 'Stream error occurred');
    await cleanupStream(clusterId, workDistributionInterval);
  });
}

/**
 * Start the work distribution loop for a cluster.
 * 
 * This loop continuously checks the cluster's Redis queue for pending work.
 * When work arrives, it's immediately pushed to the relayer via the stream.
 * 
 * Uses blocking Redis operations (BLPOP) so it doesn't spin when idle.
 * 
 * @param stream - The bidirectional stream to push work to
 * @param clusterId - Which cluster this stream belongs to
 */
function startWorkDistribution(stream: grpc.ServerDuplexStream<any, any>, clusterId: string) {
  const workQueue = getWorkQueue();

  async function distributeWork() {
    try {
      // Wait up to 5 seconds for work (non-blocking)
      const workItem = await workQueue.dequeue(clusterId, 5);

      if (workItem) {
        logger.info({
          clusterId,
          executionId: workItem.executionId,
        }, 'Pushing work to relayer');

        // Push work to relayer via stream
        stream.write({
          work_item: {
            execution_id: workItem.executionId,
            agent_id: workItem.agentId,
            agent_name: workItem.agentName,
            agent_image: workItem.agentImage,
            input_json: JSON.stringify(workItem.input),
            resources: {
              cpu: workItem.resources.cpu,
              memory: workItem.resources.memory,
              gpu: workItem.resources.gpu || '',
              timeout: workItem.resources.timeout,
            },
            retry_policy: {
              max_attempts: workItem.retryPolicy.maxAttempts,
              backoff: workItem.retryPolicy.backoff,
              initial_delay: workItem.retryPolicy.initialDelay || '1s',
            },
            use_agent_sandbox: workItem.useAgentSandbox,
            warm_pool_size: workItem.warmPoolSize,
            network_policy: workItem.networkPolicy,
            environment_variables_json: JSON.stringify(workItem.environmentVariables || {}),
          },
        });
      }

      // Continue the loop
      setImmediate(distributeWork);
    } catch (error) {
      logger.error({ error, clusterId }, 'Work distribution error');
      // Continue despite errors
      setTimeout(distributeWork, 1000);
    }
  }

  // Start the distribution loop
  distributeWork();
}

/**
 * Handle heartbeat message from relayer.
 * Updates cluster's last heartbeat timestamp and status.
 */
async function handleHeartbeat(_stream: grpc.ServerDuplexStream<any, any>, heartbeat: any) {
  const { cluster_id, status } = heartbeat;

  try {
    const prisma = await prismaManager.getClient();
    await prisma.cluster.update({
      where: {
        id: cluster_id,
        status: 'ACTIVE',
      },
      data: {
        lastHeartbeat: new Date(),
      },
    });

    // Emit heartbeat event
    await inngest.send({
      name: 'cluster.heartbeat',
      data: {
        clusterId: cluster_id,
        status: {
          activePods: status?.active_pods || 0,
          availableResources: {
            cpu: status?.available_resources?.cpu || '0',
            memory: status?.available_resources?.memory || '0',
          },
        },
        heartbeatAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    logger.error({ error, clusterId: cluster_id }, 'Failed to process heartbeat');
  } finally {
    // No disconnect needed
  }
}

/**
 * Handle execution status update from relayer.
 * Updates execution record and emits events for workflow orchestration.
 */
async function handleExecutionStatus(statusUpdate: any) {
  const { execution_id, cluster_id, status, completed_details, failed_details } = statusUpdate;

  logger.info({
    executionId: execution_id,
    status,
  }, 'Execution status update received');

  try {
    const prisma = await prismaManager.getClient();
    // Update execution record based on status
    if (status === 'STATUS_RUNNING') {
      await prisma.execution.update({
        where: { id: execution_id },
        data: {
          status: 'running',
          startedAt: new Date(),
        },
      });

      await inngest.send({
        name: 'agent.execution.started',
        data: {
          executionId: execution_id,
          agentId: '', // Would need to fetch from execution
          clusterId: cluster_id,
          podName: statusUpdate.started_details?.pod_name || '',
          startedAt: new Date().toISOString(),
        },
      });
    } else if (status === 'STATUS_COMPLETED') {
      await prisma.execution.update({
        where: { id: execution_id },
        data: {
          status: 'completed',
          result: JSON.parse(completed_details.result_json || '{}'),
          completedAt: new Date(),
          durationMs: completed_details.duration_ms,
          resourceUsage: completed_details.resource_usage as any,
        },
      });

      // THIS IS THE CRITICAL EVENT
      // This wakes up the waiting Inngest workflow in step 4
      await inngest.send({
        name: 'agent.execution.completed',
        data: {
          executionId: execution_id,
          agentId: '', // Would need to fetch from execution
          clusterId: cluster_id,
          result: JSON.parse(completed_details.result_json || '{}'),
          durationMs: completed_details.duration_ms,
          resourceUsage: completed_details.resource_usage,
          completedAt: new Date().toISOString(),
        },
      });
    } else if (status === 'STATUS_FAILED') {
      await inngest.send({
        name: 'agent.execution.failed',
        data: {
          executionId: execution_id,
          agentId: '', // Would need to fetch from execution
          clusterId: cluster_id,
          error: {
            code: failed_details.error_code,
            message: failed_details.error_message,
            exitCode: failed_details.exit_code,
          },
          attempt: failed_details.attempt,
          willRetry: failed_details.attempt < 3, // Would check actual retry policy
          failedAt: new Date().toISOString(),
        },
      });
    }
  } catch (error) {
    logger.error({ error, executionId: execution_id }, 'Failed to process status update');
  } finally {
    // No disconnect needed
  }
}

/**
 * Handle log batch from relayer.
 * Stores logs in TimescaleDB for querying.
 */
async function handleLogBatch(logBatch: any) {
  const { execution_id, logs } = logBatch;

  try {
    const prisma = await prismaManager.getClient();
    // Bulk insert logs
    await prisma.log.createMany({
      data: logs.map((log: any) => ({
        executionId: execution_id,
        timestamp: new Date(log.timestamp),
        level: log.level,
        message: log.message,
        stream: log.stream,
        metadata: log.metadata_json ? JSON.parse(log.metadata_json) : null,
      })),
    });

    // Emit event for real-time log streaming
    await inngest.send({
      name: 'agent.log.batch',
      data: {
        executionId: execution_id,
        logs: logs.map((log: any) => ({
          timestamp: new Date(log.timestamp).toISOString(),
          level: log.level,
          message: log.message,
          stream: log.stream,
        })),
      },
    });
  } catch (error) {
    logger.error({ error, executionId: execution_id }, 'Failed to store logs');
  } finally {
    // No disconnect needed
  }
}

/**
 * Handle trace batch from relayer.
 * Stores OpenTelemetry spans in TimescaleDB.
 */
async function handleTraceBatch(traceBatch: any) {
  const { execution_id, spans } = traceBatch;

  try {
    const prisma = await prismaManager.getClient();
    await prisma.trace.createMany({
      data: spans.map((span: any) => ({
        executionId: execution_id,
        traceId: span.trace_id,
        spanId: span.span_id,
        parentSpanId: span.parent_span_id || null,
        name: span.name,
        timestamp: new Date(span.start_time / 1000000), // Convert nanoseconds to milliseconds
        startTime: new Date(span.start_time / 1000000),
        endTime: new Date(span.end_time / 1000000),
        durationMs: Math.floor((span.end_time - span.start_time) / 1000000),
        attributes: JSON.parse(span.attributes_json || '{}'),
        status: span.status,
      })),
    });
  } catch (error) {
    logger.error({ error, executionId: execution_id }, 'Failed to store traces');
  } finally {
    // No disconnect needed
  }
}

/**
 * Handle metric batch from relayer.
 * Stores metrics in TimescaleDB for time-series analysis.
 */
async function handleMetricBatch(metricBatch: any) {
  const { execution_id, metrics } = metricBatch;

  try {
    const prisma = await prismaManager.getClient();
    await prisma.metric.createMany({
      data: metrics.map((metric: any) => ({
        executionId: execution_id,
        timestamp: new Date(metric.timestamp),
        name: metric.name,
        value: metric.value,
        unit: metric.unit,
        tags: metric.tags_json ? JSON.parse(metric.tags_json) : null,
      })),
    });
  } catch (error) {
    logger.error({ error, executionId: execution_id }, 'Failed to store metrics');
  } finally {
    // No disconnect needed
  }
}

/**
 * Clean up when a stream disconnects.
 * Removes from active streams map and marks cluster as disconnected.
 */
async function cleanupStream(clusterId: string | null, interval: NodeJS.Timeout | null) {
  if (clusterId) {
    activeStreams.delete(clusterId);

    try {
      const prisma = await prismaManager.getClient();
      await prisma.cluster.update({
        where: { id: clusterId },
        data: {
          status: 'INACTIVE',
          streamId: null,
        },
      });

      await inngest.send({
        name: 'cluster.disconnected',
        data: {
          clusterId,
          reason: 'graceful',
          disconnectedAt: new Date().toISOString(),
        },
      });
    } catch (error) {
      logger.error({ error, clusterId }, 'Failed to update cluster status');
    } finally {
      // No disconnect needed
    }
  }

  if (interval) {
    clearInterval(interval);
  }
}

/**
 * Start the gRPC server.
 * Binds to the configured port and starts accepting connections.
 * 
 * @param port - Port to listen on
 * @returns Promise that resolves when server is started
 */
export async function startGrpcServer(port: number = 50051): Promise<grpc.Server> {
  const proto = loadProtoDefinition();
  const server = new grpc.Server();

  // Register service implementations
  server.addService(proto.ConsonantControlPlane.service, {
    RegisterCluster: registerCluster,
    StreamWork: streamWork,
  });

  // Bind and start
  return new Promise(async (resolve, reject) => {
    // Determine credentials based on environment
    let credentials: grpc.ServerCredentials;

    if (process.env.GRPC_TLS_CERT && process.env.GRPC_TLS_KEY) {
      // Production: Use TLS with provided certificates
      const fs = await import('fs');
      try {
        const cert = fs.readFileSync(process.env.GRPC_TLS_CERT);
        const key = fs.readFileSync(process.env.GRPC_TLS_KEY);

        credentials = grpc.ServerCredentials.createSsl(
          null, // No client certificate required
          [{ private_key: key, cert_chain: cert }],
          false // Don't require client certificates
        );

        logger.info('gRPC server configured with TLS');
      } catch (error) {
        logger.error({ error }, 'Failed to load TLS certificates, falling back to insecure');
        credentials = grpc.ServerCredentials.createInsecure();
      }
    } else {
      // Development: Use insecure credentials (no TLS)
      credentials = grpc.ServerCredentials.createInsecure();
      logger.warn('gRPC server running without TLS - only for development');
    }

    server.bindAsync(
      `0.0.0.0:${port}`,
      credentials,
      (error, boundPort) => {
        if (error) {
          logger.error({ error }, 'Failed to bind gRPC server');
          reject(error);
        } else {
          server.start();
          logger.info({ port: boundPort, tls: !!process.env.GRPC_TLS_CERT }, 'gRPC server started');
          resolve(server);
        }
      }
    );
  });
}