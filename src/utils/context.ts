import { AsyncLocalStorage } from 'node:async_hooks';
import { generateUUID } from './crypto.js';
export interface ExecutionContext {
  traceId: string;
  spanId?: string;
  requestId: string;
  clusterId?: string;
  agentName?: string;
  agentRunId?: string;
  userId?: string;
  sessionId?: string;
  correlationId?: string;
  causationId?: string;
  parentSpanId?: string;
  startTime: number;
  metadata?: Record<string, any>;
}

export class ContextManager {
  private static instance: ContextManager;
  private storage: AsyncLocalStorage<ExecutionContext>;

  private constructor() {
    this.storage = new AsyncLocalStorage<ExecutionContext>();
  }

  static getInstance(): ContextManager {
    if (!ContextManager.instance) {
      ContextManager.instance = new ContextManager();
    }
    return ContextManager.instance;
  }

  getStore(): ExecutionContext | undefined {
    return this.storage.getStore();
  }

  run<T>(context: Partial<ExecutionContext>, callback: () => T): T {
    const fullContext: ExecutionContext = {
      traceId: context.traceId || generateUUID(),
      requestId: context.requestId || generateUUID(),
      startTime: context.startTime || Date.now(),
      ...context,
    };
    return this.storage.run(fullContext, callback);
  }

  enterWith(context: Partial<ExecutionContext>): void {
    const fullContext: ExecutionContext = {
      traceId: context.traceId || generateUUID(),
      requestId: context.requestId || generateUUID(),
      startTime: context.startTime || Date.now(),
      ...context,
    };
    this.storage.enterWith(fullContext);
  }

  getTraceId(): string | undefined {
    return this.storage.getStore()?.traceId;
  }

  getRequestId(): string | undefined {
    return this.storage.getStore()?.requestId;
  }

  getClusterId(): string | undefined {
    return this.storage.getStore()?.clusterId;
  }

  getAgentRunId(): string | undefined {
    return this.storage.getStore()?.agentRunId;
  }

  setClusterId(clusterId: string): void {
    const store = this.storage.getStore();
    if (store) {
      store.clusterId = clusterId;
    }
  }

  setAgentRunId(agentRunId: string): void {
    const store = this.storage.getStore();
    if (store) {
      store.agentRunId = agentRunId;
    }
  }

  setMetadata(key: string, value: any): void {
    const store = this.storage.getStore();
    if (store) {
      if (!store.metadata) {
        store.metadata = {};
      }
      store.metadata[key] = value;
    }
  }

  getMetadata(key: string): any {
    return this.storage.getStore()?.metadata?.[key];
  }

  getAllContext(): ExecutionContext | undefined {
    return this.storage.getStore();
  }

  clear(): void {
    this.storage.disable();
  }
}

export const contextManager = ContextManager.getInstance();