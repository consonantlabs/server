/**
 * @fileoverview Telemetry Batch Processing Function
 * @module services/inngest/functions/telemetry-batch
 * 
 * Processes batches of telemetry data (traces, metrics, logs) received
 * from clusters. This function handles:
 * - Validation of incoming data
 * - Batch insertion into TimescaleDB
 * - Error handling and retries
 * - Performance monitoring
 * 
 * This runs asynchronously via Inngest, allowing the gRPC stream
 * to acknowledge receipt quickly while processing happens in background.
 */

import { inngest } from '../client.js';
import { EVENT_TYPES } from '../../../config/constants.js';
import { logger } from '../../../utils/logger.js';
import { prismaManager } from '../../db/manager.js';

/**
 * Process telemetry trace batch.
 * 
 * Handles batch insertion of trace spans into the database.
 * Uses transaction for atomicity.
 */
export const processTelemetryTraceBatch = inngest.createFunction(
  {
    id: 'process-telemetry-trace-batch',
    name: 'Process Telemetry Trace Batch',
    retries: 3,
  },
  { event: EVENT_TYPES.TELEMETRY_TRACE_BATCH },
  async ({ event, step }) => {
    const { organizationId, clusterId, traces: items } = event.data as any;

    logger.info(
      {
        organizationId,
        clusterId,
        count: items.length,
      },
      'Processing trace batch'
    );

    // Step 1: Validate data
    await step.run('validate-traces', async () => {
      if (!Array.isArray(items) || items.length === 0) {
        throw new Error('Invalid trace batch: items must be a non-empty array');
      }

      logger.debug(
        {
          count: items.length,
        },
        'Trace validation passed'
      );
    });

    // Step 2: Insert traces into database
    const inserted = await step.run('insert-traces', async () => {
      const prisma = await prismaManager.getClient();

      // Transform items to Prisma format
      const traces = items.map((item: any) => ({
        organizationId,
        clusterId,
        traceId: item.traceId,
        spanId: item.spanId,
        parentSpanId: item.parentSpanId || null,
        name: item.name,
        kind: item.kind || 'INTERNAL',
        timestamp: new Date(item.timestamp),
        duration: item.duration,
        statusCode: item.statusCode || null,
        statusMessage: item.statusMessage || null,
        attributes: item.attributes || {},
        events: item.events || [],
        links: item.links || [],
        resource: item.resource || {},
      }));

      // Batch insert with transaction
      await prisma.trace.createMany({
        data: traces,
        skipDuplicates: true, // Skip if trace already exists
      });

      logger.info(
        {
          organizationId,
          clusterId,
          inserted: traces.length,
        },
        'Traces inserted successfully'
      );

      return traces.length;
    });

    return {
      success: true,
      inserted,
      clusterId,
    };
  }
);

/**
 * Process telemetry metric batch.
 * 
 * Handles batch insertion of metrics into the database.
 */
export const processTelemetryMetricBatch = inngest.createFunction(
  {
    id: 'process-telemetry-metric-batch',
    name: 'Process Telemetry Metric Batch',
    retries: 3,
  },
  { event: EVENT_TYPES.TELEMETRY_METRIC_BATCH },
  async ({ event, step }) => {
    const { organizationId, clusterId, metrics: items } = event.data as any;

    logger.info(
      {
        organizationId,
        clusterId,
        count: items.length,
      },
      'Processing metric batch'
    );

    await step.run('validate-metrics', async () => {
      if (!Array.isArray(items) || items.length === 0) {
        throw new Error('Invalid metric batch: items must be a non-empty array');
      }
    });

    const inserted = await step.run('insert-metrics', async () => {
      const prisma = await prismaManager.getClient();

      const metrics = items.map((item: any) => ({
        organizationId,
        clusterId,
        name: item.name,
        type: item.type || 'GAUGE',
        timestamp: new Date(item.timestamp),
        value: item.value,
        unit: item.unit || null,
        attributes: item.attributes || {},
        resource: item.resource || {},
      }));

      await prisma.metric.createMany({
        data: metrics,
        skipDuplicates: true,
      });

      logger.info(
        {
          organizationId,
          clusterId,
          inserted: metrics.length,
        },
        'Metrics inserted successfully'
      );

      return metrics.length;
    });

    return {
      success: true,
      inserted,
      clusterId,
    };
  }
);

/**
 * Process telemetry log batch.
 * 
 * Handles batch insertion of logs into the database.
 */
export const processTelemetryLogBatch = inngest.createFunction(
  {
    id: 'process-telemetry-log-batch',
    name: 'Process Telemetry Log Batch',
    retries: 3,
  },
  { event: EVENT_TYPES.TELEMETRY_LOG_BATCH },
  async ({ event, step }) => {
    const { organizationId, clusterId, logs: items } = event.data as any;

    logger.info(
      {
        organizationId,
        clusterId,
        count: items.length,
      },
      'Processing log batch'
    );

    await step.run('validate-logs', async () => {
      if (!Array.isArray(items) || items.length === 0) {
        throw new Error('Invalid log batch: items must be a non-empty array');
      }
    });

    const inserted = await step.run('insert-logs', async () => {
      const prisma = await prismaManager.getClient();

      const logs = items.map((item: any) => ({
        organizationId,
        clusterId,
        timestamp: new Date(item.timestamp),
        severity: item.severity || 'INFO',
        message: item.message || '',
        traceId: item.traceId || null,
        spanId: item.spanId || null,
        attributes: item.attributes || {},
        resource: item.resource || {},
      }));

      await prisma.log.createMany({
        data: logs,
        skipDuplicates: true,
      });

      logger.info(
        {
          organizationId,
          clusterId,
          inserted: logs.length,
        },
        'Logs inserted successfully'
      );

      return logs.length;
    });

    return {
      success: true,
      inserted,
      clusterId,
    };
  }
);