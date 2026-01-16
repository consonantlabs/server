export enum TelemetryEventType {
  AGENT_REASONING = 'agent:reasoning',
  AGENT_TOOL_CALL = 'agent:tool_call',
  AGENT_LLM_CALL = 'agent:llm_call',
  AGENT_ERROR = 'agent:error',
  K8S_POD_EVENT = 'k8s:pod_event',
  K8S_DEPLOYMENT_EVENT = 'k8s:deployment_event',
  K8S_WARNING = 'k8s:warning',
  MEDIATOR_ERROR = 'mediator:error',
  MEDIATOR_HEALTH = 'mediator:health',
  OTEL_TRACE_SPAN = 'otel:trace_span',
  OTEL_METRIC = 'otel:metric',
  SYSTEM_LOG = 'system:log',
}

export enum LogLevel {
  TRACE = 'trace',
  DEBUG = 'debug',
  INFO = 'info',
  WARN = 'warn',
  ERROR = 'error',
  FATAL = 'fatal',
}

export interface TelemetryContext {
  traceId: string;
  spanId?: string;
  parentSpanId?: string;
  requestId: string;
  clusterId: string;
  agentName?: string;
  agentRunId?: string;
  timestamp: number;
}

export interface TelemetryEvent {
  id: string;
  type: TelemetryEventType;
  context: TelemetryContext;
  level: LogLevel;
  message: string;
  payload: any;
  tags?: Record<string, string>;
  metadata?: Record<string, any>;
}

export interface AgentReasoningEvent extends TelemetryEvent {
  type: TelemetryEventType.AGENT_REASONING;
  payload: {
    step: number;
    thought: string;
    action?: string;
    actionInput?: any;
    observation?: string;
  };
}

export interface AgentToolCallEvent extends TelemetryEvent {
  type: TelemetryEventType.AGENT_TOOL_CALL;
  payload: {
    tool: string;
    input: any;
    output?: any;
    duration: number;
    success: boolean;
    error?: string;
  };
}

export interface AgentLLMCallEvent extends TelemetryEvent {
  type: TelemetryEventType.AGENT_LLM_CALL;
  payload: {
    model: string;
    prompt: string;
    response: string;
    tokensUsed: number;
    duration: number;
  };
}

export interface K8sPodEvent extends TelemetryEvent {
  type: TelemetryEventType.K8S_POD_EVENT;
  payload: {
    podName: string;
    namespace: string;
    phase: string;
    reason?: string;
    message?: string;
    containerStatuses?: any[];
  };
}

export interface OTelTraceSpan extends TelemetryEvent {
  type: TelemetryEventType.OTEL_TRACE_SPAN;
  payload: {
    spanId: string;
    traceId: string;
    parentSpanId?: string;
    name: string;
    startTime: string;
    endTime?: string;
    duration?: number;
    attributes: Record<string, any>;
    events: Array<{
      name: string;
      timestamp: string;
      attributes: Record<string, any>;
    }>;
    status: {
      code: number;
      message?: string;
    };
  };
}

export interface SystemLogEvent extends TelemetryEvent {
  type: TelemetryEventType.SYSTEM_LOG;
  payload: {
    source: 'backend' | 'mediator' | 'kagent';
    logger: string;
    error?: {
      name: string;
      message: string;
      stack?: string;
    };
  };
}