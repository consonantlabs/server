/**
 * @fileoverview Structured Logger
 * @module utils/logger
 * 
 * Provides high-performance structured logging using Pino.
 * Automatically injects execution context (trace ID, request ID, etc.)
 * into every log entry via the context manager.
 * 
 * Features:
 * - JSON structured logging
 * - Automatic context injection (trace ID, request ID, etc.)
 * - Pretty printing in development
 * - Performance optimized (Pino is 5x faster than Winston)
 * - Safe serialization of errors and circular references
 * - PII redaction support
 * 
 * Log Levels (from lowest to highest):
 * - trace: Very detailed debugging
 * - debug: Debugging information
 * - info: General information
 * - warn: Warning conditions
 * - error: Error conditions
 * - fatal: Fatal errors (application crash)
 */

import pino from 'pino';
import { contextManager } from './context.js';
import { env, isDevelopment } from '@/config/env.js';

/**
 * Create Pino logger instance with context injection.
 * 
 * The mixin function runs on every log line and automatically
 * injects execution context from the context manager. This means
 * every log entry will include trace ID, request ID, and other
 * context without manual parameter passing.
 * 
 * In development: Uses pino-pretty for human-readable output
 * In production: Outputs JSON for log aggregation systems
 */
export const logger = pino({
  level: env.LOG_LEVEL,

  /**
   * Mixin function that runs on every log entry.
   * 
   * Automatically injects execution context into log entries.
   * If we're outside a request context (like at startup), returns empty object.
   */
  mixin() {
    const context = contextManager.getAllContext();

    // Outside request context (startup, background jobs, etc.)
    if (!context) {
      return {};
    }

    // Inject context into every log entry
    return {
      traceId: context.traceId,
      spanId: context.spanId,
      parentSpanId: context.parentSpanId,
      requestId: context.requestId,
      organizationId: context.organizationId,
      clusterId: context.clusterId,
      userId: context.userId,
    };
  },

  /**
   * Base properties included in every log entry.
   */
  base: {
    service: env.OTEL_SERVICE_NAME,
    environment: env.OTEL_ENVIRONMENT,
    version: env.OTEL_SERVICE_VERSION,
  },

  /**
   * Timestamp format.
   * Uses ISO 8601 for consistency with OpenTelemetry.
   */
  timestamp: pino.stdTimeFunctions.isoTime,

  /**
   * Safe serialization of errors.
   * Ensures stack traces are properly captured.
   */
  serializers: {
    err: pino.stdSerializers.err,
    error: pino.stdSerializers.err,
    req: pino.stdSerializers.req,
    res: pino.stdSerializers.res,
  },

  /**
   * Pretty printing in development for readability.
   * In production, output raw JSON for log aggregation.
   */
  transport: isDevelopment()
    ? {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'HH:MM:ss.l',
        ignore: 'pid,hostname',
        singleLine: false,
        messageFormat: '{levelLabel} [{traceId}] {msg}',
      },
    }
    : undefined,

  /**
   * Redaction configuration.
   * Automatically redact sensitive fields from logs.
   */
  redact: {
    paths: [
      'password',
      'secret',
      'token',
      'apiKey',
      'api_key',
      'authorization',
      'cookie',
      '*.password',
      '*.secret',
      '*.token',
      '*.apiKey',
      '*.api_key',
    ],
    remove: true, // Remove sensitive fields entirely
  },
});

/**
 * Internal logger without context injection.
 * 
 * Use this for logging within the logger/telemetry infrastructure
 * itself to prevent infinite loops. This logger does NOT inject
 * context, so it's safe to use in the context manager and telemetry
 * collectors.
 * 
 * @example
 * // In TelemetryCollector
 * internalLogger.info('Flushed telemetry batch');
 */
export const internalLogger = pino({
  level: env.LOG_LEVEL,
  base: {
    service: env.OTEL_SERVICE_NAME,
    environment: env.OTEL_ENVIRONMENT,
  },
});

/**
 * Create a child logger with additional bindings.
 * 
 * Child loggers inherit the parent's configuration but can add
 * additional fields that will be included in every log entry.
 * 
 * @param bindings - Additional fields to include
 * @returns Child logger
 * 
 * @example
 * const clusterLogger = logger.child({ component: 'cluster-manager' });
 * clusterLogger.info('Cluster connected'); // Includes component field
 */
export function createChildLogger(bindings: Record<string, unknown>): pino.Logger {
  return logger.child(bindings);
}

/**
 * Log and throw an error.
 * 
 * Logs the error at ERROR level and then throws it.
 * Useful for error handling where you want to log before propagating.
 * 
 * @param message - Error message
 * @param error - Original error
 * @param metadata - Additional metadata
 * @throws {Error} Always throws the error
 * 
 * @example
 * try {
 *   await dangerousOperation();
 * } catch (err) {
 *   logAndThrow('Operation failed', err, { operation: 'dangerousOperation' });
 * }
 */
export function logAndThrow(
  message: string,
  error?: Error,
  metadata?: Record<string, unknown>
): never {
  logger.error(
    {
      err: error,
      ...metadata,
    },
    message
  );

  throw error || new Error(message);
}

/**
 * Create a timer for measuring operation duration.
 * 
 * Returns a function that when called, logs the elapsed time.
 * 
 * @param operation - Operation name
 * @returns Timer function
 * 
 * @example
 * const timer = createTimer('database-query');
 * await performQuery();
 * timer(); // Logs: "database-query completed in 150ms"
 */
export function createTimer(operation: string): () => void {
  const start = Date.now();

  return () => {
    const duration = Date.now() - start;
    logger.debug({ operation, durationMs: duration }, `${operation} completed`);
  };
}

/**
 * Log with performance timing.
 * 
 * Automatically measures and logs the duration of an async operation.
 * 
 * @param operation - Operation name
 * @param fn - Async function to measure
 * @returns Function result
 * 
 * @example
 * const result = await withTiming('fetch-user', async () => {
 *   return await fetchUser(userId);
 * });
 * // Logs: "fetch-user completed in 250ms"
 */
export async function withTiming<T>(
  operation: string,
  fn: () => Promise<T>
): Promise<T> {
  const start = Date.now();

  try {
    const result = await fn();
    const duration = Date.now() - start;

    logger.debug(
      { operation, durationMs: duration },
      `${operation} completed`
    );

    return result;
  } catch (error) {
    const duration = Date.now() - start;

    logger.error(
      {
        err: error,
        operation,
        durationMs: duration,
      },
      `${operation} failed`
    );

    throw error;
  }
}

/**
 * Safely serialize an object for logging.
 * 
 * Handles circular references and other serialization issues.
 * Useful for logging complex objects that might have circular refs.
 * 
 * @param obj - Object to serialize
 * @param maxDepth - Maximum depth to serialize
 * @returns Safely serialized object
 */
export function safeSerialize(obj: unknown, maxDepth: number = 10): unknown {
  const seen = new WeakSet();

  function serialize(value: unknown, depth: number): unknown {
    if (depth > maxDepth) {
      return '[MAX_DEPTH]';
    }

    if (value === null || value === undefined) {
      return value;
    }

    if (typeof value !== 'object') {
      return value;
    }

    if (seen.has(value as object)) {
      return '[CIRCULAR]';
    }

    seen.add(value as object);

    if (Array.isArray(value)) {
      return value.map(item => serialize(item, depth + 1));
    }

    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
        stack: value.stack,
      };
    }

    if (value instanceof Date) {
      return value.toISOString();
    }

    const serialized: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      serialized[key] = serialize(val, depth + 1);
    }

    return serialized;
  }

  return serialize(obj, 0);
}

/**
 * Log levels enum for type safety.
 */
export enum LogLevel {
  TRACE = 'trace',
  DEBUG = 'debug',
  INFO = 'info',
  WARN = 'warn',
  ERROR = 'error',
  FATAL = 'fatal',
}

/**
 * Set log level dynamically.
 * 
 * Useful for debugging in production without restart.
 * 
 * @param level - New log level
 * 
 * @example
 * setLogLevel(LogLevel.DEBUG); // Enable debug logs
 */
export function setLogLevel(level: LogLevel): void {
  logger.level = level;
}

/**
 * Get current log level.
 * 
 * @returns Current log level
 */
export function getLogLevel(): string {
  return logger.level;
}

/**
 * Flush logger buffers.
 * 
 * Ensures all pending log entries are written.
 * Call this before process exit.
 * 
 * @returns Promise that resolves when flushed
 */
export async function flushLogger(): Promise<void> {
  return new Promise((resolve) => {
    logger.flush(() => resolve());
  });
}