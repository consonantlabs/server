// @ts-ignore
import { Server as SocketIOServer } from 'socket.io';
import { EventEmitter } from 'events';
import { TelemetryEvent } from './types.js';
import { internalLogger as logger } from '../../utils/logger.js';

export interface ObservabilityConfig {
  enabled: boolean;
  provider?: 'datadog' | 'honeycomb' | 'newrelic' | 'grafana' | 'otlp' | 'custom';
  endpoint?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  batchSize?: number;
  flushInterval?: number;
}

export class TelemetryRouter extends EventEmitter {
  private uiNamespace: any;
  private externalForwarder?: ExternalTelemetryForwarder;
  private eventBuffer: Map<string, TelemetryEvent[]> = new Map();

  constructor(
    private io: SocketIOServer,
    private observabilityConfig: ObservabilityConfig | null
  ) {
    super();
    this.uiNamespace = this.io.of('/telemetry');
    this.setupUINamespace();

    if (this.observabilityConfig?.enabled && this.observabilityConfig.endpoint) {
      this.externalForwarder = new ExternalTelemetryForwarder(
        this.observabilityConfig,
        logger
      );
    }
  }

  private setupUINamespace(): void {
    this.uiNamespace.on('connection', (socket: any) => {
      logger.info({
        socketId: socket.id
      }, 'UI client connected to telemetry stream');

      socket.on('subscribe', (data: { clusterId: string; filters?: any }) => {
        socket.join(`cluster:${data.clusterId}`);
        logger.info({
          clusterId: data.clusterId,
          socketId: socket.id,
        }, 'UI subscribed to cluster telemetry');

        const buffered = this.eventBuffer.get(data.clusterId) || [];
        if (buffered.length > 0) {
          socket.emit('telemetry:batch', buffered);
          this.eventBuffer.delete(data.clusterId);
        }
      });

      socket.on('unsubscribe', (data: { clusterId: string }) => {
        socket.leave(`cluster:${data.clusterId}`);
        logger.info({
          clusterId: data.clusterId,
        }, 'UI unsubscribed from cluster telemetry');
      });

      socket.on('disconnect', () => {
        logger.info({
          socketId: socket.id,
        }, 'UI client disconnected from telemetry stream');
      });
    });
  }

  async route(events: TelemetryEvent[]): Promise<void> {
    if (events.length === 0) return;

    await Promise.all([
      this.routeToUI(events),
      this.routeToExternal(events),
    ]);
  }

  private async routeToUI(events: TelemetryEvent[]): Promise<void> {
    const eventsByCluster = new Map<string, TelemetryEvent[]>();

    for (const event of events) {
      const clusterId = event.context.clusterId;
      if (!eventsByCluster.has(clusterId)) {
        eventsByCluster.set(clusterId, []);
      }
      eventsByCluster.get(clusterId)!.push(event);
    }

    for (const [clusterId, clusterEvents] of eventsByCluster) {
      const room = `cluster:${clusterId}`;
      const sockets = await this.uiNamespace.in(room).fetchSockets();

      if (sockets.length > 0) {
        this.uiNamespace.to(room).emit('telemetry:batch', clusterEvents);
      } else {
        const buffer = this.eventBuffer.get(clusterId) || [];
        buffer.push(...clusterEvents);

        if (buffer.length > 1000) {
          buffer.splice(0, buffer.length - 1000);
        }

        this.eventBuffer.set(clusterId, buffer);
      }
    }

    logger.debug(`Routed ${events.length} events to UI`);
  }

  private async routeToExternal(events: TelemetryEvent[]): Promise<void> {
    if (!this.externalForwarder) return;

    try {
      await this.externalForwarder.forward(events);
      logger.debug(`Forwarded ${events.length} events to external collector`);
    } catch (error) {
      logger.error({ error }, 'Failed to forward events to external collector');
      this.emit('forward:error', error);
    }
  }

  async updateConfig(config: ObservabilityConfig | null): Promise<void> {
    if (config?.enabled && config.endpoint) {
      if (this.externalForwarder) {
        await this.externalForwarder.updateConfig(config);
      } else {
        this.externalForwarder = new ExternalTelemetryForwarder(config, logger);
      }
      logger.info({
        provider: config.provider,
        endpoint: config.endpoint,
      }, 'External telemetry forwarder updated');
    } else {
      if (this.externalForwarder) {
        await this.externalForwarder.shutdown();
        this.externalForwarder = undefined;
      }
      logger.info('External telemetry forwarder disabled');
    }
  }

  getStats() {
    return {
      uiConnections: this.uiNamespace.sockets.size,
      bufferedEvents: Array.from(this.eventBuffer.values()).reduce(
        (sum, events) => sum + events.length,
        0
      ),
      externalForwarderActive: !!this.externalForwarder,
    };
  }

  async shutdown(): Promise<void> {
    if (this.externalForwarder) {
      await this.externalForwarder.shutdown();
    }
    this.eventBuffer.clear();
    this.removeAllListeners();
    logger.info('Telemetry router shut down');
  }
}

class ExternalTelemetryForwarder {
  private buffer: TelemetryEvent[] = [];
  private flushTimer?: NodeJS.Timeout;
  private readonly batchSize: number;
  private readonly flushInterval: number;

  constructor(
    private config: ObservabilityConfig,
    private logger: any
  ) {
    this.batchSize = config.batchSize || 100;
    this.flushInterval = config.flushInterval || 5000;
    this.startFlushTimer();
  }

  async forward(events: TelemetryEvent[]): Promise<void> {
    this.buffer.push(...events);

    if (this.buffer.length >= this.batchSize) {
      await this.flush();
    }
  }

  private async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const events = [...this.buffer];
    this.buffer = [];

    try {
      await this.send(events);
    } catch (error) {
      this.logger.error('Failed to send telemetry batch', error as Error);
      throw error;
    }
  }

  private async send(events: TelemetryEvent[]): Promise<void> {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10000); // 10s timeout
    const payload = this.transformForProvider(events);

    const response = await fetch(this.config.endpoint!, {
      method: 'POST',
      signal: controller.signal, // Pass the signal
      headers: {
        'Content-Type': 'application/json',
        ...(this.config.apiKey && { 'X-API-Key': this.config.apiKey }),
        ...this.config.headers,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(
        `External collector returned ${response.status}: ${await response.text()}`
      );
    }

    this.logger.debug(`Sent ${events.length} events to ${this.config.provider}`);
  }

  private transformForProvider(events: TelemetryEvent[]): any {
    switch (this.config.provider) {
      case 'otlp':
        return this.transformToOTLP(events);
      case 'datadog':
        return this.transformToDatadog(events);
      case 'honeycomb':
        return this.transformToHoneycomb(events);
      default:
        return events;
    }
  }

  private transformToOTLP(events: TelemetryEvent[]): any {
    const logs = events.map(event => ({
      timeUnixNano: String(event.context.timestamp * 1000000),
      severityText: event.level.toUpperCase(),
      severityNumber: this.getSeverityNumber(event.level),
      body: { stringValue: event.message },
      attributes: [
        { key: 'event.type', value: { stringValue: event.type } },
        { key: 'trace.id', value: { stringValue: event.context.traceId } },
        { key: 'span.id', value: { stringValue: event.context.spanId || '' } },
        { key: 'cluster.id', value: { stringValue: event.context.clusterId } },
        ...(event.context.agentRunId ? [
          { key: 'agent.run.id', value: { stringValue: event.context.agentRunId } }
        ] : []),
        ...Object.entries(event.payload || {}).map(([k, v]) => ({
          key: `payload.${k}`,
          value: { stringValue: JSON.stringify(v) },
        })),
      ],
      traceId: event.context.traceId,
      spanId: event.context.spanId || '',
    }));

    return {
      resourceLogs: [{
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: 'terra' } },
          ],
        },
        scopeLogs: [{
          scope: { name: 'terra-telemetry' },
          logRecords: logs,
        }],
      }],
    };
  }

  private transformToDatadog(events: TelemetryEvent[]): any {
    return events.map(event => ({
      ddsource: 'terra',
      ddtags: Object.entries(event.tags || {})
        .map(([k, v]) => `${k}:${v}`)
        .join(','),
      hostname: event.context.clusterId,
      message: event.message,
      service: 'terra',
      status: event.level,
      timestamp: event.context.timestamp,
      trace_id: event.context.traceId,
      span_id: event.context.spanId,
      attributes: event.payload,
    }));
  }

  private transformToHoneycomb(events: TelemetryEvent[]): any {
    return events.map(event => ({
      time: new Date(event.context.timestamp).toISOString(),
      data: {
        message: event.message,
        level: event.level,
        type: event.type,
        trace_id: event.context.traceId,
        span_id: event.context.spanId,
        cluster_id: event.context.clusterId,
        agent_run_id: event.context.agentRunId,
        ...event.payload,
        ...event.tags,
      },
    }));
  }

  private getSeverityNumber(level: string): number {
    const map: Record<string, number> = {
      trace: 1,
      debug: 5,
      info: 9,
      warn: 13,
      error: 17,
      fatal: 21,
    };
    return map[level.toLowerCase()] || 9;
  }

  private startFlushTimer(): void {
    this.flushTimer = setInterval(() => {
      this.flush().catch(err =>
        this.logger.error('Flush timer error', err)
      );
    }, this.flushInterval);
  }

  async updateConfig(config: ObservabilityConfig): Promise<void> {
    await this.flush();
    this.config = config;
    this.logger.info('External forwarder config updated');
  }

  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
    }
    await this.flush();
    this.logger.info('External telemetry forwarder shut down');
  }
}