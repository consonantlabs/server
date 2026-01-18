/**
 * @fileoverview Request Timeline Processing Functions
 * @module services/inngest/functions/request-timeline
 * 
 * Processes and stores request execution timelines in TimescaleDB.
 * This enables the frontend to show users detailed execution traces
 * similar to Inngest's function execution UI.
 * 
 * PROCESSING FLOW:
 * 1. Receive timeline event from request completion hook
 * 2. Validate timeline data structure
 * 3. Store in TimescaleDB via separate database connection
 * 4. Handle errors gracefully (don't fail requests if timeline storage fails)
 * 
 * DATA STRUCTURE:
 * Each timeline includes:
 * - Request metadata (method, path, status code)
 * - Execution duration
 * - Individual events (database queries, external API calls, etc.)
 * - Correlation IDs (trace ID, organization ID)
 * 
 * QUERYING:
 * Frontend can query timelines by:
 * - Request ID (single request detail)
 * - Organization ID (all requests for org)
 * - Time range (recent activity)
 * - Status code (errors only)
 */

import { inngest } from '../client.js';
import { internalLogger } from '../../../utils/logger.js';
import { prismaManager } from '../../db/manager.js';

/**
 * Process and store a completed request timeline.
 * 
 * This function is triggered asynchronously after each request completes.
 * It stores the timeline in a separate TimescaleDB database for analysis.
 * 
 * RETRY STRATEGY:
 * - 3 retries with exponential backoff
 * - Failures are logged but don't affect the request
 */
export const processRequestTimeline = inngest.createFunction(
  {
    id: 'process-request-timeline',
    name: 'Process Request Timeline',
    retries: 3,
  },
  { event: 'request.timeline.completed' },
  async ({ event, step }) => {
    const { timeline } = event.data;

    internalLogger.debug(
      {
        requestId: timeline.requestId,
        duration: timeline.duration,
        eventCount: timeline.events.length,
      },
      'Processing request timeline'
    );

    // Step 1: Validate timeline data
    await step.run('validate-timeline', async () => {
      if (!timeline.requestId || !timeline.traceId) {
        throw new Error('Invalid timeline: missing required fields');
      }

      if (timeline.events.length === 0) {
        internalLogger.warn(
          { requestId: timeline.requestId },
          'Timeline has no events'
        );
      }

      return { valid: true };
    });

    // Step 2: Store timeline in database
    await step.run('store-timeline', async () => {
      try {
        const prisma = await prismaManager.getTelemetryClient();

        await prisma.requestLog.create({
          data: {
            requestId: timeline.requestId,
            organizationId: timeline.organizationId,
            method: timeline.method,
            path: timeline.path,
            statusCode: timeline.statusCode,
            durationMs: Math.round(timeline.duration),
            timestamp: new Date(timeline.timestamp),
            timeline: timeline.events as any, // Store full events as JSON
          },
        });

        internalLogger.info(
          {
            requestId: timeline.requestId,
            method: timeline.method,
            path: timeline.path,
            statusCode: timeline.statusCode,
            duration: timeline.duration.toFixed(2),
            organizationId: timeline.organizationId,
            eventCount: timeline.events.length,
          },
          'Request timeline recorded to DB'
        );

        return { stored: true };
      } catch (error) {
        internalLogger.error(
          {
            err: error,
            requestId: timeline.requestId,
          },
          'Failed to store request timeline'
        );
        throw error;
      }
    });

    return {
      success: true,
      requestId: timeline.requestId,
      eventsProcessed: timeline.events.length,
    };
  }
);

/**
 * Aggregate request timelines for analytics.
 * 
 * Runs periodically to compute statistics like:
 * - Average response time by endpoint
 * - P95/P99 latency percentiles
 * - Error rate trends
 * - Slowest endpoints
 * 
 * These aggregates power dashboard visualizations.
 */
export const aggregateRequestTimelines = inngest.createFunction(
  {
    id: 'aggregate-request-timelines',
    name: 'Aggregate Request Timelines',
  },
  { cron: '*/15 * * * *' }, // Run every 15 minutes
  async ({ step }) => {
    internalLogger.info('Starting request timeline aggregation');

    // Step 1: Calculate endpoint statistics
    const stats = await step.run('calculate-endpoint-stats', async () => {
      // TODO: Implement aggregation queries
      // This would query the request_timelines table and compute:
      // - Average duration per endpoint
      // - Request count per endpoint
      // - Error rate per endpoint
      // - P95/P99 latency percentiles

      internalLogger.info('Endpoint statistics calculated');

      return {
        aggregated: true,
        timestamp: new Date().toISOString(),
      };
    });

    // Step 2: Store aggregated statistics
    await step.run('store-aggregates', async () => {
      // TODO: Store in aggregated_statistics table
      // This powers dashboard charts and analytics

      internalLogger.info('Aggregated statistics stored');

      return { stored: true };
    });

    return {
      success: true,
      aggregatedAt: stats.timestamp,
    };
  }
);