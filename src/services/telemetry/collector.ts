import { EventEmitter } from 'events';
import { TelemetryEvent, TelemetryEventType, LogLevel, TelemetryContext } from './types.js';
import { generateUUID } from '@/utils/crypto.js';
import { contextManager } from '@/utils/context.js';

export interface TelemetryCollectorConfig {
  clusterId: string;
  bufferSize?: number;
  flushInterval?: number;
}

export class TelemetryCollector extends EventEmitter {
  private buffer: TelemetryEvent[] = [];
  private flushTimer?: NodeJS.Timeout;
  private readonly maxBufferSize: number;
  private readonly flushInterval: number;

  constructor(
    private config: TelemetryCollectorConfig,
    private logger: any
  ) {
    super();
    this.maxBufferSize = config.bufferSize || 100;
    this.flushInterval = config.flushInterval || 1000;
    this.startFlushTimer();
  }

  collect(event: Partial<TelemetryEvent>): void {
    // Inside TelemetryCollector.collect
const activeContext = contextManager.getAllContext();
    const fullEvent: TelemetryEvent = {
      id: event.id || `evt_${Date.now()}_${generateUUID()}`,
      type: event.type!,
      context: {
        clusterId: this.config.clusterId,
        timestamp: Date.now(),
        // Use context from contextManager if not explicitly provided
    traceId: event.context?.traceId || activeContext?.traceId,
    requestId: event.context?.requestId || activeContext?.requestId,
    agentRunId: event.context?.agentRunId || activeContext?.agentRunId,
        ...event.context,
      } as TelemetryContext,
      level: event.level || LogLevel.INFO,
      message: event.message || '',
      payload: event.payload || {},
      tags: event.tags,
      metadata: event.metadata,
    };

    this.buffer.push(fullEvent);

    if (this.buffer.length >= this.maxBufferSize) {
      this.flush();
    }
  }

  collectAgentReasoning(context: Partial<TelemetryContext>, reasoning: {
    step: number;
    thought: string;
    action?: string;
    actionInput?: any;
    observation?: string;
  }): void {
    this.collect({
      type: TelemetryEventType.AGENT_REASONING,
      context: context as TelemetryContext,
      level: LogLevel.INFO,
      message: `Agent reasoning step ${reasoning.step}`,
      payload: reasoning,
      tags: {
        agent: context.agentName || 'unknown',
        step: reasoning.step.toString(),
      },
    });
  }

  collectToolCall(context: Partial<TelemetryContext>, toolCall: {
    tool: string;
    input: any;
    output?: any;
    duration: number;
    success: boolean;
    error?: string;
  }): void {
    this.collect({
      type: TelemetryEventType.AGENT_TOOL_CALL,
      context: context as TelemetryContext,
      level: toolCall.success ? LogLevel.INFO : LogLevel.ERROR,
      message: `Tool ${toolCall.tool} ${toolCall.success ? 'succeeded' : 'failed'}`,
      payload: toolCall,
      tags: {
        tool: toolCall.tool,
        success: toolCall.success.toString(),
      },
    });
  }

  collectLLMCall(context: Partial<TelemetryContext>, llmCall: {
    model: string;
    prompt: string;
    response: string;
    tokensUsed: number;
    duration: number;
  }): void {
    this.collect({
      type: TelemetryEventType.AGENT_LLM_CALL,
      context: context as TelemetryContext,
      level: LogLevel.INFO,
      message: `LLM call to ${llmCall.model}`,
      payload: {
        ...llmCall,
        prompt: this.truncate(llmCall.prompt, 500),
        response: this.truncate(llmCall.response, 500),
      },
      tags: {
        model: llmCall.model,
        tokens: llmCall.tokensUsed.toString(),
      },
    });
  }

  collectPodEvent(context: Partial<TelemetryContext>, podEvent: {
    podName: string;
    namespace: string;
    phase: string;
    reason?: string;
    message?: string;
    containerStatuses?: any[];
  }): void {
    const level = podEvent.phase === 'Failed' ? LogLevel.ERROR : 
                  podEvent.phase === 'Unknown' ? LogLevel.WARN : 
                  LogLevel.INFO;

    this.collect({
      type: TelemetryEventType.K8S_POD_EVENT,
      context: context as TelemetryContext,
      level,
      message: `Pod ${podEvent.podName}: ${podEvent.phase}`,
      payload: podEvent,
      tags: {
        pod: podEvent.podName,
        namespace: podEvent.namespace,
        phase: podEvent.phase,
      },
    });
  }

  collectOTelSpan(context: Partial<TelemetryContext>, span: {
    spanId: string;
    traceId: string;
    parentSpanId?: string;
    name: string;
    startTime: string;
    endTime?: string;
    duration?: number;
    attributes: Record<string, any>;
    events: any[];
    status: { code: number; message?: string };
  }): void {
    this.collect({
      type: TelemetryEventType.OTEL_TRACE_SPAN,
      context: {
        ...context,
        traceId: span.traceId,
        spanId: span.spanId,
        parentSpanId: span.parentSpanId,
      } as TelemetryContext,
      level: span.status.code === 2 ? LogLevel.ERROR : LogLevel.DEBUG,
      message: `Span: ${span.name}`,
      payload: span,
      tags: {
        span_name: span.name,
        status: span.status.code.toString(),
      },
    });
  }

  collectSystemLog(context: Partial<TelemetryContext>, log: {
    source: 'backend' | 'mediator' | 'kagent';
    logger: string;
    level: LogLevel;
    message: string;
    error?: Error;
    metadata?: any;
  }): void {
    this.collect({
      type: TelemetryEventType.SYSTEM_LOG,
      context: context as TelemetryContext,
      level: log.level,
      message: log.message,
      payload: {
        source: log.source,
        logger: log.logger,
        metadata: log.metadata,
        ...(log.error && {
          error: {
            name: log.error.name,
            message: log.error.message,
            stack: process.env.NODE_ENV !== 'production' ? log.error.stack : undefined,
          },
        }),
      },
      tags: {
        source: log.source,
        logger: log.logger,
      },
    });
  }

  private flush(): void {
    if (this.buffer.length === 0) return;

    const events = [...this.buffer];
    this.buffer = [];

    this.emit('flush', events);

    this.logger.debug(`Flushed ${events.length} telemetry events`);
  }

  private startFlushTimer(): void {
    this.flushTimer = setInterval(() => {
      this.flush();
    }, this.flushInterval);
  }

  private truncate(str: string, maxLength: number): string {
    if (str.length <= maxLength) return str;
    return str.substring(0, maxLength) + '... (truncated)';
  }

  getBufferSize(): number {
    return this.buffer.length;
  }

  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
    }
    this.flush();
    this.removeAllListeners();
    this.logger.info('Telemetry collector shut down');
  }
}