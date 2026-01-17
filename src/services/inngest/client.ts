/**
 * @fileoverview Inngest Client
 * @module services/inngest/client
 * 
 * Provides the Inngest client for event-driven workflows.
 * 
 * Inngest advantages over BullMQ:
 * - Higher-level abstraction for workflows
 * - Built-in retry logic with exponential backoff
 * - Native observability and debugging
 * - Type-safe event schemas
 * - Automatic idempotency
 * - Step functions for complex workflows
 * - No need to manage separate queue workers
 * 
 * Inngest handles:
 * - Telemetry batch processing
 * - Cluster lifecycle events
 * - API key rotation/expiration
 * - Data retention cleanup
 * - Metric aggregation
 * - Organization events
 */

import { Inngest } from 'inngest';
import { env } from '@/config/env.js';
import { logger } from '@/utils/logger.js';
import { ConsonantEvents, schemas } from './events.js';




/**
 * Inngest client instance.
 * 
 * This is the main client for emitting events and creating functions.
 * Configured with the application's event schemas for type safety.
 * 
 * @example
 * import { inngest } from '@/services/inngest/client';
 * 
 * // Emit an event
 * await inngest.send({
 *   name: 'telemetry.trace.batch',
 *   data: {
 *     organizationId: 'org-123',
 *     clusterId: 'cluster-456',
 *     type: 'trace',
 *     items: traces,
 *     timestamp: new Date().toISOString(),
 *   },
 * });
 */
export const inngest = new Inngest({
  id: env.INNGEST_APP_ID,
  schemas,
  eventKey: env.INNGEST_EVENT_KEY,
});

/**
 * Helper function to emit events with automatic logging.
 * 
 * This wrapper adds logging around event emission for observability.
 * 
 * @param event - Event to send
 * 
 * @example
 * await sendEvent({
 *   name: 'cluster.connected',
 *   data: {
 *     organizationId: 'org-123',
 *     clusterId: 'cluster-456',
 *     clusterName: 'production',
 *     namespace: 'default',
 *     relayerVersion: '1.0.0',
 *     timestamp: new Date().toISOString(),
 *   },
 * });
 */
export async function sendEvent<T extends keyof ConsonantEvents>(
  event: {
    name: T;
    data: ConsonantEvents[T]['data'];
  }
): Promise<void> {
  try {
    logger.debug(
      {
        eventName: event.name,
        data: event.data,
      },
      'Sending Inngest event'
    );

    await inngest.send(event as any);

    logger.info(
      {
        eventName: event.name,
      },
      'Inngest event sent successfully'
    );
  } catch (error) {
    logger.error(
      {
        err: error,
        eventName: event.name,
      },
      'Failed to send Inngest event'
    );
    throw error;
  }
}

/**
 * Helper function to emit multiple events in batch.
 * 
 * More efficient than sending events one by one.
 * 
 * @param events - Array of events to send
 * 
 * @example
 * await sendEvents([
 *   {
 *     name: 'cluster.heartbeat',
 *     data: { ... },
 *   },
 *   {
 *     name: 'cluster.heartbeat',
 *     data: { ... },
 *   },
 * ]);
 */
export async function sendEvents<T extends keyof ConsonantEvents>(
  events: Array<{
    name: T;
    data: ConsonantEvents[T]['data'];
  }>
): Promise<void> {
  try {
    logger.debug(
      {
        count: events.length,
      },
      'Sending batch of Inngest events'
    );

    await inngest.send(events as any);

    logger.info(
      {
        count: events.length,
      },
      'Inngest events sent successfully'
    );
  } catch (error) {
    logger.error(
      {
        err: error,
        count: events.length,
      },
      'Failed to send Inngest events'
    );
    throw error;
  }
}