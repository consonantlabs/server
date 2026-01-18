import { logger } from '../../../utils/logger.js';
import { prismaManager } from '../../db/manager.js';
import { inngest } from '../../inngest/client.js';

/**
 * EventHandler processes messages received from relayers via gRPC streams.
 * It transforms raw Protobuf messages into domain events and database records.
 */
export class EventHandler {
  /**
   * Handle execution status updates from relayer.
   * This updates the central execution record and forwards events to Inngest for orchestration.
   * 
   * @example
   * ```ts
   * await eventHandler.handleExecutionStatus('cluster-123', {
   *   execution_id: 'exec-456',
   *   status: 'STATUS_RUNNING',
   *   timestamp: Date.now()
   * });
   * ```
   */
  async handleExecutionStatus(clusterId: string, status: any): Promise<void> {
    const executionId = status.execution_id;
    logger.info({ clusterId, executionId, status: status.status }, 'Processing execution status update');

    try {
      const prisma = await prismaManager.getClient();
      const eventName = this.getStatusEventName(status.status);

      // Fetch execution to get organizationId (required for multi-tenancy)
      const execution = await prisma.execution.findUnique({
        where: { id: executionId },
        include: { agent: { select: { organizationId: true } } }
      });

      if (!execution) {
        logger.warn({ executionId }, 'Execution not found for status update');
        return;
      }

      const organizationId = execution.agent.organizationId;

      // 1. Update Execution Record
      await prisma.execution.update({
        where: { id: executionId },
        data: {
          status: this.mapProtoStatusToDb(status.status),
          lastStatusUpdate: new Date(Number(status.timestamp)),
          startedAt: status.status === 'STATUS_RUNNING' ? new Date(Number(status.timestamp)) : undefined,
          completedAt: status.status === 'STATUS_COMPLETED' ? new Date(Number(status.timestamp)) : undefined,
          result: status.completed_details?.result_json ? JSON.parse(status.completed_details.result_json) : undefined,
          error: status.failed_details?.error_message,
          durationMs: status.completed_details?.duration_ms ? Number(status.completed_details.duration_ms) : undefined,
        }
      });

      // 2. Forward to Inngest
      if (eventName) {
        await inngest.send({
          name: eventName,
          data: {
            executionId,
            clusterId,
            organizationId,
            status: status.status,
            ...status.started_details,
            ...status.completed_details,
            ...status.failed_details
          }
        });
      }

      // 3. Audit Log
      await prisma.auditLog.create({
        data: {
          organizationId,
          action: 'EXECUTION_STATUS_UPDATED',
          resourceType: 'Execution',
          resourceId: executionId,
          metadata: { status: status.status, clusterId }
        }
      });

    } catch (err) {
      logger.error({ err, executionId, clusterId }, 'Failed to handle execution status update');
    }
  }

  /**
   * Handle logs from an execution.
   * Logs are batched and stored in the primary database (or TimescaleDB) for retrieval via REST API.
   * 
   * @example
   * ```ts
   * await eventHandler.handleLogBatch('cluster-123', {
   *   execution_id: 'exec-456',
   *   logs: [{ level: 'info', message: 'Hello world', timestamp: Date.now() }]
   * });
   * ```
   */
  async handleLogBatch(clusterId: string, batch: any): Promise<void> {
    const executionId = batch.execution_id;
    const logEntries = batch.logs || [];
    if (logEntries.length === 0) return;

    try {
      const prisma = await prismaManager.getClient();
      const execution = await prisma.execution.findUnique({
        where: { id: executionId },
        select: { agent: { select: { organizationId: true } } }
      });

      if (!execution) return;

      await prisma.log.createMany({
        data: logEntries.map((log: any) => ({
          organizationId: execution.agent.organizationId,
          executionId,
          clusterId,
          timestamp: new Date(Number(log.timestamp)),
          severity: log.level.toUpperCase(),
          message: log.message,
          stream: log.stream || 'stdout',
          metadata: log.metadata_json ? JSON.parse(log.metadata_json) : {}
        }))
      });
    } catch (err) {
      logger.error({ err, executionId, clusterId }, 'Failed to handle log batch');
    }
  }

  /**
   * Handle metrics from an execution.
   * 
   * @example
   * ```ts
   * await eventHandler.handleMetricBatch('cluster-123', {
   *   execution_id: 'exec-456',
   *   metrics: [{ name: 'cpu', value: 0.5, timestamp: Date.now() }]
   * });
   * ```
   */
  async handleMetricBatch(clusterId: string, batch: any): Promise<void> {
    const executionId = batch.execution_id;
    const metricPoints = batch.metrics || [];
    if (metricPoints.length === 0) return;

    try {
      const prisma = await prismaManager.getClient();
      const execution = await prisma.execution.findUnique({
        where: { id: executionId },
        select: { agent: { select: { organizationId: true } } }
      });

      if (!execution) return;

      await prisma.metric.createMany({
        data: metricPoints.map((m: any) => ({
          organizationId: execution.agent.organizationId,
          executionId,
          clusterId,
          name: m.name,
          type: 'GAUGE', // Defaulting to GAUGE for simple points
          timestamp: new Date(Number(m.timestamp)),
          value: Number(m.value),
          unit: m.unit,
          attributes: m.tags_json ? JSON.parse(m.tags_json) : {}
        }))
      });
    } catch (err) {
      logger.error({ err, executionId, clusterId }, 'Failed to handle metric batch');
    }
  }

  /**
   * Handle trace spans from an execution.
   * Spans are stored in TimescaleDB for distributed tracing visualization.
   * 
   * @example
   * ```ts
   * await eventHandler.handleTraceBatch('cluster-123', {
   *   execution_id: 'exec-456',
   *   spans: [{ trace_id: '...', span_id: '...', name: 'op1', timestamp: Date.now(), duration: 100 }]
   * });
   * ```
   */
  async handleTraceBatch(clusterId: string, batch: any): Promise<void> {
    const executionId = batch.execution_id;
    const spans = batch.spans || [];
    if (spans.length === 0) return;

    try {
      const prisma = await prismaManager.getClient();
      const execution = await prisma.execution.findUnique({
        where: { id: executionId },
        select: { agent: { select: { organizationId: true } } }
      });

      if (!execution) return;

      await prisma.trace.createMany({
        data: spans.map((s: any) => ({
          organizationId: execution.agent.organizationId,
          executionId,
          clusterId,
          traceId: s.trace_id,
          spanId: s.span_id,
          parentSpanId: s.parent_span_id,
          name: s.name,
          kind: s.kind || 'INTERNAL',
          timestamp: new Date(Number(s.timestamp)),
          duration: Number(s.duration),
          statusCode: s.status_code,
          statusMessage: s.status_message,
          attributes: s.attributes_json ? JSON.parse(s.attributes_json) : {},
          resource: s.resource_json ? JSON.parse(s.resource_json) : {}
        }))
      });
    } catch (err) {
      logger.error({ err, executionId, clusterId }, 'Failed to handle trace batch');
    }
  }

  private mapProtoStatusToDb(protoStatus: string): any {
    switch (protoStatus) {
      case 'STATUS_RECEIVED': return 'PENDING';
      case 'STATUS_CREATING':
      case 'STATUS_STARTING': return 'QUEUED';
      case 'STATUS_RUNNING': return 'RUNNING';
      case 'STATUS_COMPLETED': return 'COMPLETED';
      case 'STATUS_FAILED': return 'FAILED';
      default: return 'PENDING';
    }
  }

  private getStatusEventName(statusEnum: string): any {
    switch (statusEnum) {
      case 'STATUS_RUNNING': return 'agent.execution.started';
      case 'STATUS_COMPLETED': return 'agent.execution.completed';
      case 'STATUS_FAILED': return 'agent.execution.failed';
      default: return null;
    }
  }
}

let eventHandlerInstance: EventHandler | null = null;

export function getEventHandler(): EventHandler {
  if (!eventHandlerInstance) {
    eventHandlerInstance = new EventHandler();
  }
  return eventHandlerInstance;
}