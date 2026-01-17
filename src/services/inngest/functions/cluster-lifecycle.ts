/**
 * @fileoverview Cluster Lifecycle Functions
 * @module services/inngest/functions/cluster-lifecycle
 * 
 * Handles cluster lifecycle events:
 * - Connection tracking
 * - Disconnection cleanup
 * - Heartbeat monitoring
 * - Error logging and alerting
 * 
 * These functions maintain cluster state and trigger appropriate
 * actions when clusters connect, disconnect, or encounter errors.
 */

import { inngest } from '../client.js';
import { EVENT_TYPES } from '../../../config/constants.js';
import { logger } from '../../../utils/logger.js';
import { prismaManager } from '../../db/manager.js';

/**
 * Handle cluster connection event.
 * 
 * Updates database with connection timestamp and status.
 * This runs when a cluster successfully establishes gRPC connection.
 */
export const handleClusterConnected = inngest.createFunction(
  {
    id: 'handle-cluster-connected',
    name: 'Handle Cluster Connected',
    retries: 2,
  },
  { event: EVENT_TYPES.CLUSTER_CONNECTED },
  async ({ event, step }) => {
    const {
      clusterId,
      capabilities,
      relayerVersion,
      connectedAt: timestamp,
    } = event.data;

    logger.info(
      {
        clusterId,
      },
      'Handling cluster connection'
    );

    await step.run('update-cluster-status', async () => {
      const prisma = await prismaManager.getClient();

      await prisma.cluster.update({
        where: { id: clusterId },
        data: {
          status: 'ACTIVE',
          lastHeartbeat: new Date(timestamp),
          relayerVersion,
          relayerConfig: capabilities as any,
        },
      });

      logger.info(
        {
          clusterId,
          status: 'ACTIVE',
        },
        'Cluster status updated'
      );
    });

    return {
      success: true,
      clusterId,
      status: 'ACTIVE',
      timestamp,
    };
  }
);

/**
 * Handle cluster disconnection event.
 * 
 * Updates database status and triggers cleanup if needed.
 * Runs when a cluster's gRPC connection closes.
 */
export const handleClusterDisconnected = inngest.createFunction(
  {
    id: 'handle-cluster-disconnected',
    name: 'Handle Cluster Disconnected',
    retries: 2,
  },
  { event: EVENT_TYPES.CLUSTER_DISCONNECTED },
  async ({ event, step }) => {
    const { clusterId, disconnectedAt: timestamp, reason } = event.data;

    // Need to find organization from API key
    logger.info(
      {
        clusterId,
        reason,
      },
      'Handling cluster disconnection'
    );

    await step.run('update-cluster-status', async () => {
      const prisma = await prismaManager.getClient();

      await prisma.cluster.update({
        where: { id: clusterId },
        data: {
          status: 'INACTIVE',
          lastHeartbeat: new Date(timestamp),
        },
      });

      logger.info(
        {
          clusterId,
          status: 'INACTIVE',
        },
        'Cluster status updated'
      );
    });

    // Optional: Send notification or alert
    // await step.run('send-notification', async () => {
    //   await sendSlackNotification({
    //     message: `Cluster ${clusterId} disconnected`,
    //     reason,
    //   });
    // });

    return {
      success: true,
      clusterId,
      status: 'INACTIVE',
      reason,
      timestamp,
    };
  }
);

/**
 * Handle cluster heartbeat event.
 * 
 * Updates last seen timestamp to track cluster health.
 * Runs periodically as clusters send heartbeats.
 */
export const handleClusterHeartbeat = inngest.createFunction(
  {
    id: 'handle-cluster-heartbeat',
    name: 'Handle Cluster Heartbeat',
    retries: 1, // Low retry for heartbeats
  },
  { event: EVENT_TYPES.CLUSTER_HEARTBEAT },
  async ({ event, step }) => {
    const { clusterId, heartbeatAt } = event.data;

    logger.debug(
      {
        clusterId,
      },
      'Handling cluster heartbeat'
    );

    await step.run('update-last-seen', async () => {
      const prisma = await prismaManager.getClient();

      await prisma.cluster.update({
        where: { id: clusterId },
        data: {
          lastHeartbeat: new Date(heartbeatAt), // Changed lastSeenAt to lastHeartbeat and used heartbeatAt
        },
      });
    });

    return {
      success: true,
      clusterId,
      timestamp: heartbeatAt,
    };
  }
);

/**
 * Handle cluster error event.
 * 
 * Logs errors and can trigger alerts for critical issues.
 * Runs when clusters report errors.
 */
export const handleClusterError = inngest.createFunction(
  {
    id: 'handle-cluster-error',
    name: 'Handle Cluster Error',
    retries: 2,
  },
  { event: EVENT_TYPES.CLUSTER_ERROR },
  async ({ event }) => {
    const { clusterId, error, timestamp } = event.data as any;

    logger.error(
      {
        clusterId,
        error,
        timestamp,
      },
      'Cluster reported error'
    );

    // Optional: Store error in database for analytics
    // await step.run('store-error', async () => {
    //   const prisma = await prismaManager.getClient();
    //   await prisma.clusterError.create({
    //     data: {
    //       clusterId,
    //       error,
    //       stack,
    //       timestamp: new Date(timestamp),
    //     },
    //   });
    // });

    // Optional: Send alert for critical errors
    // await step.run('send-alert', async () => {
    //   if (isCriticalError(error)) {
    //     await sendPagerDutyAlert({
    //       message: `Critical error in cluster ${clusterId}`,
    //       error,
    //     });
    //   }
    // });

    return {
      success: true,
      clusterId,
      error,
      timestamp,
    };
  }
);

/**
 * Monitor cluster health and detect stale connections.
 * 
 * Runs periodically (e.g., every 5 minutes) to detect clusters
 * that haven't sent heartbeats and mark them as INACTIVE.
 */
export const monitorClusterHealth = inngest.createFunction(
  {
    id: 'monitor-cluster-health',
    name: 'Monitor Cluster Health',
  },
  { cron: '*/5 * * * *' }, // Every 5 minutes
  async ({ step }) => {
    logger.info('Starting cluster health monitoring');

    const results = await step.run('check-stale-clusters', async () => {
      const prisma = await prismaManager.getClient();

      // Find clusters that haven't been seen in 2 minutes
      const staleThreshold = new Date(Date.now() - 2 * 60 * 1000);

      const staleClusters = await prisma.cluster.findMany({
        where: {
          status: 'ACTIVE',
          lastHeartbeat: {
            lt: staleThreshold,
          },
        },
      });

      logger.info(
        {
          count: staleClusters.length,
        },
        'Found stale clusters'
      );

      // Mark stale clusters as INACTIVE
      if (staleClusters.length > 0) {
        await prisma.cluster.updateMany({
          where: {
            id: {
              in: staleClusters.map(c => c.id),
            },
          },
          data: {
            status: 'INACTIVE',
          },
        });

        logger.warn(
          {
            clusterIds: staleClusters.map(c => c.id),
          },
          'Marked stale clusters as INACTIVE'
        );
      }

      return {
        checked: staleClusters.length,
        marked: staleClusters.length,
      };
    });

    return {
      success: true,
      results,
      timestamp: new Date().toISOString(),
    };
  }
);