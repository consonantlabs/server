/**
 * @fileoverview Telemetry Routes
 * @module routes/telemetry
 * 
 * REST API routes for querying telemetry data.
 * 
 * These routes handle:
 * - Querying traces by time range and filters
 * - Getting complete trace details with all spans
 * - Querying metrics with aggregations
 * - Querying logs with search and filtering
 * 
 * All routes require API key authentication and are organization-scoped.
 */

import type { FastifyInstance } from 'fastify';
import {
  listTraces,
  getTrace,
  listMetrics,
  listLogs,
} from '@/controllers/telemetry.controller.js';

/**
 * Register telemetry routes with Fastify.
 * 
 * Routes:
 * - GET /organizations/:organizationId/traces
 * - GET /organizations/:organizationId/traces/:traceId
 * - GET /organizations/:organizationId/metrics
 * - GET /organizations/:organizationId/logs
 * 
 * @param app - Fastify instance
 */
export async function telemetryRoutes(app: FastifyInstance): Promise<void> {
  /**
   * List traces for an organization.
   * 
   * GET /organizations/:organizationId/traces
   * 
   * Query Parameters:
   * - startTime: ISO 8601 date (optional)
   * - endTime: ISO 8601 date (optional)
   * - traceId: Trace ID filter (optional)
   * - spanId: Span ID filter (optional)
   * - serviceName: Service name filter (optional)
   * - limit: Number of results (default: 50, max: 1000)
   * - offset: Pagination offset (default: 0)
   * 
   * Returns:
   * - Array of trace spans matching filters
   * - Pagination metadata
   */
  app.get(
    '/organizations/:organizationId/traces',
    listTraces
  );

  /**
   * Get a complete trace by trace ID.
   * 
   * GET /organizations/:organizationId/traces/:traceId
   * 
   * Returns:
   * - All spans for the trace
   * - Spans nested by parent-child relationships
   * - Total trace duration
   * - Span count
   */
  app.get(
    '/organizations/:organizationId/traces/:traceId',
    getTrace
  );

  /**
   * List metrics for an organization.
   * 
   * GET /organizations/:organizationId/metrics
   * 
   * Query Parameters:
   * - startTime: ISO 8601 date (optional)
   * - endTime: ISO 8601 date (optional)
   * - name: Metric name filter (optional)
   * - type: Metric type (GAUGE, COUNTER, HISTOGRAM, SUMMARY) (optional)
   * - limit: Number of results (default: 50, max: 1000)
   * - offset: Pagination offset (default: 0)
   * 
   * Returns:
   * - Array of metric data points
   * - Pagination metadata
   */
  app.get(
    '/organizations/:organizationId/metrics',
    listMetrics
  );

  /**
   * List logs for an organization.
   * 
   * GET /organizations/:organizationId/logs
   * 
   * Query Parameters:
   * - startTime: ISO 8601 date (optional)
   * - endTime: ISO 8601 date (optional)
   * - severity: Log severity (TRACE, DEBUG, INFO, WARN, ERROR, FATAL) (optional)
   * - search: Full-text search in log message (optional)
   * - limit: Number of results (default: 50, max: 1000)
   * - offset: Pagination offset (default: 0)
   * 
   * Returns:
   * - Array of log entries
   * - Pagination metadata
   */
  app.get(
    '/organizations/:organizationId/logs',
    listLogs
  );
}