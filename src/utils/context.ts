/**
 * @fileoverview Async Context Manager
 * @module utils/context
 * 
 * Provides async context tracking using Node.js AsyncLocalStorage.
 * This enables automatic context propagation across async operations
 * without manual parameter passing.
 * 
 * Context includes:
 * - Trace ID (W3C Trace Context)
 * - Span ID
 * - Request ID
 * - Organization ID
 * - Cluster ID
 * - User ID
 * - Custom metadata
 * 
 * Usage:
 * 1. Initialize context at request/operation start
 * 2. Access context anywhere in the async chain
 * 3. Context automatically propagates through:
 *    - Promise chains
 *    - async/await
 *    - Callbacks
 *    - Event emitters
 *    - Timers
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { generateTraceId, generateSpanId, generateUUID } from './crypto.js';

/**
 * Execution context stored in AsyncLocalStorage.
 * 
 * This context automatically propagates through async operations,
 * making it available to all code in the execution chain without
 * manual parameter passing.
 */
export interface ExecutionContext {
  /** W3C Trace Context trace ID (32 hex chars) */
  traceId: string;
  
  /** Current span ID (16 hex chars) */
  spanId?: string;
  
  /** Parent span ID for nested operations */
  parentSpanId?: string;
  
  /** Unique request identifier */
  requestId: string;
  
  /** Organization ID for multi-tenancy */
  organizationId?: string;
  
  /** Cluster ID for cluster-scoped operations */
  clusterId?: string;
  
  userId?: string;

  /** Agent run ID for agent-scoped operations */
  agentRunId?: string;
  
  /** Session ID for session tracking */
  sessionId?: string;
  
  /** Correlation ID for tracking related operations */
  correlationId?: string;
  
  /** Causation ID for event sourcing */
  causationId?: string;
  
  /** Operation start time */
  startTime: number;
  
  /** Custom metadata (extensible) */
  metadata?: Record<string, unknown>;
}

/**
 * Context Manager using AsyncLocalStorage.
 * 
 * Singleton class that manages async execution context.
 * Uses AsyncLocalStorage under the hood to automatically propagate
 * context across async boundaries.
 * 
 * @example
 * // In HTTP middleware
 * app.addHook('onRequest', (request, reply, done) => {
 *   contextManager.run({
 *     traceId: request.headers['x-trace-id'] || generateTraceId(),
 *     requestId: request.id,
 *   }, done);
 * });
 * 
 * // Anywhere in request handling
 * const traceId = contextManager.getTraceId();
 * logger.info({ traceId }, 'Processing request');
 */
export class ContextManager {
  private static instance: ContextManager;
  private storage: AsyncLocalStorage<ExecutionContext>;

  private constructor() {
    this.storage = new AsyncLocalStorage<ExecutionContext>();
  }

  /**
   * Get singleton instance.
   * 
   * @returns ContextManager instance
   */
  static getInstance(): ContextManager {
    if (!ContextManager.instance) {
      ContextManager.instance = new ContextManager();
    }
    return ContextManager.instance;
  }

  /**
   * Get current execution context.
   * 
   * Returns undefined if not within a context (e.g., at startup).
   * 
   * @returns Current context or undefined
   * 
   * @example
   * const context = contextManager.getStore();
   * if (context) {
   *   console.log(`Trace ID: ${context.traceId}`);
   * }
   */
  getStore(): ExecutionContext | undefined {
    return this.storage.getStore();
  }

  /**
   * Run callback within a new execution context.
   * 
   * Creates a new context with the provided values and runs the callback.
   * The context is automatically available to all async operations within
   * the callback.
   * 
   * Missing required fields (traceId, requestId) are auto-generated.
   * 
   * @param context - Partial context to set
   * @param callback - Function to run in context
   * @returns Callback return value
   * 
   * @example
   * // HTTP request handler
   * contextManager.run({
   *   traceId: req.headers['x-trace-id'],
   *   requestId: req.id,
   *   userId: req.user?.id,
   * }, async () => {
   *   await processRequest();
   * });
   * 
   * // Inside processRequest()
   * const traceId = contextManager.getTraceId(); // Automatically available
   */
  run<T>(context: Partial<ExecutionContext>, callback: () => T): T {
    const fullContext: ExecutionContext = {
      traceId: context.traceId || generateTraceId(),
      requestId: context.requestId || generateUUID(),
      startTime: context.startTime || Date.now(),
      ...context,
    };
    
    return this.storage.run(fullContext, callback);
  }

  /**
   * Enter a context without running a callback.
   * 
   * This is useful for middleware that needs to set context
   * before the request handler runs.
   * 
   * WARNING: This is less safe than run() because the context
   * lifetime is not tied to a specific callback. Use run() when possible.
   * 
   * @param context - Partial context to set
   * 
   * @example
   * // Fastify middleware
   * app.addHook('onRequest', (request, reply, done) => {
   *   contextManager.enterWith({
   *     traceId: request.headers['x-trace-id'],
   *     requestId: request.id,
   *   });
   *   done();
   * });
   */
  enterWith(context: Partial<ExecutionContext>): void {
    const fullContext: ExecutionContext = {
      traceId: context.traceId || generateTraceId(),
      requestId: context.requestId || generateUUID(),
      startTime: context.startTime || Date.now(),
      ...context,
    };
    
    this.storage.enterWith(fullContext);
  }

  /**
   * Get trace ID from current context.
   * 
   * @returns Trace ID or undefined if no context
   */
  getTraceId(): string | undefined {
    return this.storage.getStore()?.traceId;
  }

  /**
   * Get span ID from current context.
   * 
   * @returns Span ID or undefined if no context
   */
  getSpanId(): string | undefined {
    return this.storage.getStore()?.spanId;
  }

  /**
   * Get request ID from current context.
   * 
   * @returns Request ID or undefined if no context
   */
  getRequestId(): string | undefined {
    return this.storage.getStore()?.requestId;
  }

  /**
   * Get organization ID from current context.
   * 
   * @returns Organization ID or undefined if no context
   */
  getOrganizationId(): string | undefined {
    return this.storage.getStore()?.organizationId;
  }

  /**
   * Get cluster ID from current context.
   * 
   * @returns Cluster ID or undefined if no context
   */
  getClusterId(): string | undefined {
    return this.storage.getStore()?.clusterId;
  }

  /**
   * Get user ID from current context.
   * 
   * @returns User ID or undefined if no context
   */
  getUserId(): string | undefined {
    return this.storage.getStore()?.userId;
  }

  /**
   * Set trace ID in current context.
   * 
   * @param traceId - Trace ID to set
   */
  setTraceId(traceId: string): void {
    const store = this.storage.getStore();
    if (store) {
      store.traceId = traceId;
    }
  }

  /**
   * Set span ID in current context.
   * 
   * @param spanId - Span ID to set
   */
  setSpanId(spanId: string): void {
    const store = this.storage.getStore();
    if (store) {
      store.spanId = spanId;
    }
  }

  /**
   * Set parent span ID in current context.
   * 
   * @param parentSpanId - Parent span ID to set
   */
  setParentSpanId(parentSpanId: string): void {
    const store = this.storage.getStore();
    if (store) {
      store.parentSpanId = parentSpanId;
    }
  }

  /**
   * Set organization ID in current context.
   * 
   * @param organizationId - Organization ID to set
   */
  setOrganizationId(organizationId: string): void {
    const store = this.storage.getStore();
    if (store) {
      store.organizationId = organizationId;
    }
  }

  /**
   * Set cluster ID in current context.
   * 
   * @param clusterId - Cluster ID to set
   */
  setClusterId(clusterId: string): void {
    const store = this.storage.getStore();
    if (store) {
      store.clusterId = clusterId;
    }
  }

  /**
   * Set user ID in current context.
   * 
   * @param userId - User ID to set
   */
  setUserId(userId: string): void {
    const store = this.storage.getStore();
    if (store) {
      store.userId = userId;
    }
  }

  /**
   * Set custom metadata in current context.
   * 
   * @param key - Metadata key
   * @param value - Metadata value
   */
  setMetadata(key: string, value: unknown): void {
    const store = this.storage.getStore();
    if (store) {
      if (!store.metadata) {
        store.metadata = {};
      }
      store.metadata[key] = value;
    }
  }

  /**
   * Get custom metadata from current context.
   * 
   * @param key - Metadata key
   * @returns Metadata value or undefined
   */
  getMetadata(key: string): unknown {
    return this.storage.getStore()?.metadata?.[key];
  }

  /**
   * Get all custom metadata from current context.
   * 
   * @returns Metadata object or undefined
   */
  getAllMetadata(): Record<string, unknown> | undefined {
    return this.storage.getStore()?.metadata;
  }

  /**
   * Get complete execution context.
   * 
   * @returns Complete context or undefined
   */
  getAllContext(): ExecutionContext | undefined {
    return this.storage.getStore();
  }

  /**
   * Create a child span context.
   * 
   * Useful for creating nested spans in OpenTelemetry.
   * The current span ID becomes the parent span ID.
   * 
   * @returns New context with child span
   * 
   * @example
   * const parentContext = contextManager.getAllContext();
   * 
   * contextManager.run(contextManager.createChildSpan(), async () => {
   *   // This runs in a child span
   *   await doWork();
   * });
   */
  createChildSpan(): Partial<ExecutionContext> {
    const current = this.storage.getStore();
    if (!current) {
      return {
        traceId: generateTraceId(),
        spanId: generateSpanId(),
      };
    }

    return {
      traceId: current.traceId,
      spanId: generateSpanId(),
      parentSpanId: current.spanId,
      requestId: current.requestId,
      organizationId: current.organizationId,
      clusterId: current.clusterId,
      userId: current.userId,
      startTime: Date.now(),
    };
  }

  /**
   * Clear current context.
   * 
   * Disables the current context. Use with caution as this can
   * break context propagation.
   */
  clear(): void {
    this.storage.disable();
  }

  /**
   * Get context duration in milliseconds.
   * 
   * Calculates how long the current context has been active.
   * 
   * @returns Duration in milliseconds or undefined if no context
   */
  getDuration(): number | undefined {
    const store = this.storage.getStore();
    if (!store) {
      return undefined;
    }

    return Date.now() - store.startTime;
  }
}

/**
 * Singleton instance of ContextManager.
 * 
 * Import this throughout the application for context access.
 * 
 * @example
 * import { contextManager } from '@/utils/context';
 * 
 * const traceId = contextManager.getTraceId();
 * logger.info({ traceId }, 'Processing request');
 */
export const contextManager = ContextManager.getInstance();