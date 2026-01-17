/**
 * @fileoverview Request Timeline Tracking Plugin
 * @module plugins/request-timeline
 * 
 * Captures detailed execution timelines for all HTTP requests.
 * This enables users to see exactly how their requests executed,
 * similar to Inngest's function execution UI.
 * 
 * WHAT WE TRACK:
 * - Request start and end times
 * - Database query execution times
 * - External API call durations
 * - Middleware execution times
 * - Business logic processing times
 * - Response serialization time
 * 
 * DATA STORAGE:
 * Request timelines are stored in a separate TimescaleDB database
 * for independent scaling and retention policies.
 * 
 * USAGE IN FRONTEND:
 * The frontend can query these timelines to show users:
 * - Request waterfall charts
 * - Performance bottlenecks
 * - Slowest endpoints
 * - Historical performance trends
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import { contextManager } from '@/utils/context.js';
import { logger } from '@/utils/logger.js';
import { sendEvent } from '@/services/inngest/client.js';

/**
 * Timeline event representing a specific action during request execution.
 */
interface TimelineEvent {
  /** Event name (e.g., 'database.query', 'middleware.auth') */
  name: string;

  /** Event start time (high-resolution timestamp) */
  startTime: number;

  /** Event end time (high-resolution timestamp) */
  endTime: number;

  /** Duration in milliseconds */
  duration: number;

  /** Additional metadata about the event */
  metadata?: Record<string, any>;
}

/**
 * Complete request timeline with all events.
 */
interface RequestTimeline {
  /** Unique request ID */
  requestId: string;

  /** Trace ID for distributed tracing correlation */
  traceId: string;

  /** Organization ID (if authenticated) */
  organizationId?: string;

  /** HTTP method */
  method: string;

  /** URL path */
  path: string;

  /** Query parameters */
  query?: Record<string, any>;

  /** Response status code */
  statusCode: number;

  /** Request start time */
  startTime: number;

  /** Request end time */
  endTime: number;

  /** Total duration in milliseconds */
  duration: number;

  /** Individual timeline events */
  events: TimelineEvent[];

  /** Timestamp for database storage */
  timestamp: Date;
}

/**
 * Extend Fastify request to include timeline tracking.
 */
declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Timeline for this request.
     * Use addTimelineEvent() to record events.
     */
    timeline: {
      requestId: string;
      startTime: number;
      events: TimelineEvent[];
    };

    /**
     * Add an event to the request timeline.
     * 
     * @param name - Event name
     * @param startTime - Event start time (from performance.now())
     * @param endTime - Event end time (from performance.now())
     * @param metadata - Optional event metadata
     */
    addTimelineEvent(
      name: string,
      startTime: number,
      endTime: number,
      metadata?: Record<string, any>
    ): void;

    /**
     * Start timing an operation.
     * Returns a function to call when the operation completes.
     * 
     * @param name - Operation name
     * @param metadata - Optional metadata
     * @returns Function to call when operation completes
     * 
     * @example
     * const end = request.startTiming('database.query', { table: 'users' });
     * await db.user.findMany();
     * end();
     */
    startTiming(
      name: string,
      metadata?: Record<string, any>
    ): () => void;
  }
}

/**
 * Request timeline tracking plugin.
 * 
 * This plugin decorates every request with timeline tracking capabilities
 * and automatically captures request lifecycle events.
 */
async function requestTimelinePlugin(app: FastifyInstance): Promise<void> {
  // Decorate request with timeline tracking
  app.decorateRequest('timeline', null as any);
  app.decorateRequest('addTimelineEvent', null as any);
  app.decorateRequest('startTiming', null as any);

  /**
   * Initialize timeline on request start.
   */
  app.addHook('onRequest', async (request: FastifyRequest, _reply: FastifyReply) => {
    const requestId = request.id;
    const startTime = performance.now();

    // Initialize timeline
    request.timeline = {
      requestId,
      startTime,
      events: [],
    };

    // Add method to record timeline events
    request.addTimelineEvent = (
      name: string,
      eventStartTime: number,
      eventEndTime: number,
      metadata?: Record<string, any>
    ) => {
      request.timeline.events.push({
        name,
        startTime: eventStartTime,
        endTime: eventEndTime,
        duration: eventEndTime - eventStartTime,
        metadata,
      });
    };

    // Add convenience method to start timing
    request.startTiming = (name: string, metadata?: Record<string, any>) => {
      const eventStartTime = performance.now();

      return () => {
        const eventEndTime = performance.now();
        request.addTimelineEvent(name, eventStartTime, eventEndTime, metadata);
      };
    };

    // Record request start event
    request.addTimelineEvent(
      'request.start',
      startTime,
      startTime,
      {
        method: request.method,
        path: request.url,
      }
    );
  });

  /**
   * Capture response completion and store timeline.
   */
  app.addHook('onResponse', async (request: FastifyRequest, reply: FastifyReply) => {
    const endTime = performance.now();
    const traceId = contextManager.getTraceId();
    const organizationId = contextManager.getOrganizationId();

    // Record request end event
    request.addTimelineEvent(
      'request.end',
      endTime,
      endTime,
      {
        statusCode: reply.statusCode,
      }
    );

    // Build complete timeline
    const timeline: RequestTimeline = {
      requestId: request.timeline.requestId,
      traceId: traceId || 'unknown',
      organizationId,
      method: request.method,
      path: request.url,
      query: request.query as Record<string, any>,
      statusCode: reply.statusCode,
      startTime: request.timeline.startTime,
      endTime,
      duration: endTime - request.timeline.startTime,
      events: request.timeline.events,
      timestamp: new Date(),
    };

    // Send to Inngest for async storage in TimescaleDB
    try {
      await sendEvent({
        name: 'request.timeline.completed',
        data: {
          timeline,
          timestamp: new Date().toISOString(),
        } as any,
      });
    } catch (error) {
      // Don't block response if timeline storage fails
      logger.error(
        { err: error, requestId: request.id },
        'Failed to send timeline event'
      );
    }

    // Log summary for debugging
    logger.debug(
      {
        requestId: request.timeline.requestId,
        duration: timeline.duration.toFixed(2),
        eventCount: timeline.events.length,
      },
      'Request timeline completed'
    );
  });

  app.log.info('✓ Request timeline tracking plugin registered');
}

/**
 * Export as Fastify plugin.
 */
export default fp(requestTimelinePlugin, {
  name: 'request-timeline',
  fastify: '4.x',
});