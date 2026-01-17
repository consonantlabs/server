/**
 * @fileoverview Telemetry Controller
 * @module controllers/telemetry
 * 
 * Handles queries for telemetry data stored in TimescaleDB:
 * - Query traces by time range, trace ID, or filters
 * - Query metrics by time range, metric name, or aggregations
 * - Query logs by time range, severity, or search terms
 * 
 * DESIGN PRINCIPLES:
 * - Time-series optimized queries using TimescaleDB features
 * - Organization-scoped queries (multi-tenancy)
 * - Pagination for large result sets
 * - Efficient indexing on timestamp, traceId, organizationId
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import { logger } from '@/utils/logger.js';
import { PAGINATION } from '@/config/constants.js';

/**
 * Query parameters for listing traces.
 */
interface ListTracesQuery {
  startTime?: string; // ISO date
  endTime?: string;   // ISO date
  traceId?: string;
  spanId?: string;
  serviceName?: string;
  limit?: number;
  offset?: number;
}

/**
 * URL parameters for telemetry routes.
 */
interface TelemetryParams {
  organizationId: string;
  clusterId?: string;
  traceId?: string;
  metricName?: string;
}

/**
 * Query traces for an organization.
 * 
 * GET /api/v1/organizations/:organizationId/traces
 * 
 * Supports filtering by:
 * - Time range (startTime, endTime)
 * - Trace ID (exact match)
 * - Span ID (exact match)
 * - Service name (exact match)
 * 
 * Returns paginated results ordered by timestamp descending.
 * 
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function listTraces(
  request: FastifyRequest<{
    Params: TelemetryParams;
    Querystring: ListTracesQuery;
  }>,
  reply: FastifyReply
): Promise<void> {
  const { organizationId } = request.params;
  const {
    startTime,
    endTime,
    traceId,
    spanId,
    serviceName,
    limit = PAGINATION.DEFAULT_LIMIT,
    offset = PAGINATION.DEFAULT_OFFSET,
  } = request.query;

  logger.debug(
    {
      organizationId,
      filters: { startTime, endTime, traceId, spanId, serviceName },
    },
    'Querying traces'
  );

  try {
    // Build where clause
    const where: any = {
      organizationId,
    };

    // Time range filter
    if (startTime || endTime) {
      where.timestamp = {};
      if (startTime) {
        where.timestamp.gte = new Date(startTime);
      }
      if (endTime) {
        where.timestamp.lte = new Date(endTime);
      }
    }

    // Trace ID filter
    if (traceId) {
      where.traceId = traceId;
    }

    // Span ID filter
    if (spanId) {
      where.spanId = spanId;
    }

    // Service name filter (from resource attributes)
    if (serviceName) {
      where.resource = {
        path: ['service', 'name'],
        equals: serviceName,
      };
    }

    // Execute query with pagination
    const [traces, total] = await Promise.all([
      request.prisma.trace.findMany({
        where,
        orderBy: {
          timestamp: 'desc',
        },
        take: Math.min(limit, PAGINATION.MAX_LIMIT),
        skip: offset,
        select: {
          id: true,
          traceId: true,
          spanId: true,
          parentSpanId: true,
          name: true,
          kind: true,
          timestamp: true,
          duration: true,
          statusCode: true,
          statusMessage: true,
          attributes: true,
          events: true,
          resource: true,
        },
      }),
      request.prisma.trace.count({ where }),
    ]);

    reply.send({
      success: true,
      data: traces.map(trace => ({
        ...trace,
        timestamp: trace.timestamp.toISOString(),
      })),
      meta: {
        total,
        limit,
        offset,
        hasMore: offset + traces.length < total,
      },
    });
  } catch (error) {
    logger.error(
      {
        err: error,
        organizationId,
      },
      'Failed to query traces'
    );

    reply.code(500).send({
      success: false,
      error: 'Failed to query traces',
    });
  }
}

/**
 * Get a complete trace by trace ID.
 * 
 * GET /api/v1/organizations/:organizationId/traces/:traceId
 * 
 * Returns all spans for a trace, properly nested by parent-child relationships.
 * 
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function getTrace(
  request: FastifyRequest<{
    Params: TelemetryParams;
  }>,
  reply: FastifyReply
): Promise<void> {
  const { organizationId, traceId } = request.params;

  logger.debug(
    {
      organizationId,
      traceId,
    },
    'Getting trace'
  );

  try {
    // Get all spans for this trace
    const spans = await request.prisma.trace.findMany({
      where: {
        organizationId,
        traceId,
      },
      orderBy: {
        timestamp: 'asc',
      },
    });

    if (spans.length === 0) {
      reply.code(404).send({
        success: false,
        error: 'Trace not found',
      });
      return;
    }

    // Build span tree (root spans with nested children)
    const spanMap = new Map(spans.map(span => [span.spanId, { ...span, children: [] as any[] }]));
    const rootSpans: any[] = [];

    for (const span of spanMap.values()) {
      if (span.parentSpanId && spanMap.has(span.parentSpanId)) {
        spanMap.get(span.parentSpanId)!.children.push(span);
      } else {
        rootSpans.push(span);
      }
    }

    reply.send({
      success: true,
      data: {
        traceId,
        spans: rootSpans.map(formatSpanTree),
        totalSpans: spans.length,
        duration: calculateTraceDuration(spans),
      },
    });
  } catch (error) {
    logger.error(
      {
        err: error,
        organizationId,
        traceId,
      },
      'Failed to get trace'
    );

    reply.code(500).send({
      success: false,
      error: 'Failed to get trace',
    });
  }
}

/**
 * Format span tree for response.
 */
function formatSpanTree(span: any): any {
  return {
    spanId: span.spanId,
    parentSpanId: span.parentSpanId,
    name: span.name,
    kind: span.kind,
    timestamp: span.timestamp.toISOString(),
    duration: span.duration,
    statusCode: span.statusCode,
    statusMessage: span.statusMessage,
    attributes: span.attributes,
    events: span.events,
    resource: span.resource,
    children: span.children.map(formatSpanTree),
  };
}

/**
 * Calculate total trace duration from spans.
 */
function calculateTraceDuration(spans: any[]): number {
  if (spans.length === 0) return 0;
  
  const timestamps = spans.map(s => s.timestamp.getTime());
  const durations = spans.map(s => s.duration || 0);
  
  const start = Math.min(...timestamps);
  const end = Math.max(...timestamps.map((t, i) => t + durations[i]));
  
  return end - start;
}

/**
 * Query metrics for an organization.
 * 
 * GET /api/v1/organizations/:organizationId/metrics
 * 
 * Supports filtering and aggregation.
 * 
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function listMetrics(
  request: FastifyRequest<{
    Params: TelemetryParams;
    Querystring: {
      startTime?: string;
      endTime?: string;
      name?: string;
      type?: string;
      limit?: number;
      offset?: number;
    };
  }>,
  reply: FastifyReply
): Promise<void> {
  const { organizationId } = request.params;
  const {
    startTime,
    endTime,
    name,
    type,
    limit = PAGINATION.DEFAULT_LIMIT,
    offset = PAGINATION.DEFAULT_OFFSET,
  } = request.query;

  logger.debug(
    {
      organizationId,
      filters: { startTime, endTime, name, type },
    },
    'Querying metrics'
  );

  try {
    const where: any = { organizationId };

    if (startTime || endTime) {
      where.timestamp = {};
      if (startTime) where.timestamp.gte = new Date(startTime);
      if (endTime) where.timestamp.lte = new Date(endTime);
    }

    if (name) where.name = name;
    if (type) where.type = type;

    const [metrics, total] = await Promise.all([
      request.prisma.metric.findMany({
        where,
        orderBy: { timestamp: 'desc' },
        take: Math.min(limit, PAGINATION.MAX_LIMIT),
        skip: offset,
      }),
      request.prisma.metric.count({ where }),
    ]);

    reply.send({
      success: true,
      data: metrics.map(m => ({
        ...m,
        timestamp: m.timestamp.toISOString(),
      })),
      meta: { total, limit, offset, hasMore: offset + metrics.length < total },
    });
  } catch (error) {
    logger.error({ err: error, organizationId }, 'Failed to query metrics');
    reply.code(500).send({ success: false, error: 'Failed to query metrics' });
  }
}

/**
 * Query logs for an organization.
 * 
 * GET /api/v1/organizations/:organizationId/logs
 * 
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function listLogs(
  request: FastifyRequest<{
    Params: TelemetryParams;
    Querystring: {
      startTime?: string;
      endTime?: string;
      severity?: string;
      search?: string;
      limit?: number;
      offset?: number;
    };
  }>,
  reply: FastifyReply
): Promise<void> {
  const { organizationId } = request.params;
  const {
    startTime,
    endTime,
    severity,
    search,
    limit = PAGINATION.DEFAULT_LIMIT,
    offset = PAGINATION.DEFAULT_OFFSET,
  } = request.query;

  try {
    const where: any = { organizationId };

    if (startTime || endTime) {
      where.timestamp = {};
      if (startTime) where.timestamp.gte = new Date(startTime);
      if (endTime) where.timestamp.lte = new Date(endTime);
    }

    if (severity) where.severity = severity;
    if (search) where.message = { contains: search, mode: 'insensitive' };

    const [logs, total] = await Promise.all([
      request.prisma.log.findMany({
        where,
        orderBy: { timestamp: 'desc' },
        take: Math.min(limit, PAGINATION.MAX_LIMIT),
        skip: offset,
      }),
      request.prisma.log.count({ where }),
    ]);

    reply.send({
      success: true,
      data: logs.map(l => ({ ...l, timestamp: l.timestamp.toISOString() })),
      meta: { total, limit, offset, hasMore: offset + logs.length < total },
    });
  } catch (error) {
    logger.error({ err: error, organizationId }, 'Failed to query logs');
    reply.code(500).send({ success: false, error: 'Failed to query logs' });
  }
}