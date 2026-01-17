// @ts-ignore
import type { Event } from '@consonant/proto-relayer';
import { logger } from '../../../utils/logger.js';
import { prismaManager } from '../../db/manager.js';

/**
 * Handles events received from relayers
 */
export class EventHandler {
  /**
   * Handle event from relayer
   */
  async handleEvent(clusterId: string, event: Event): Promise<void> {
    logger.debug({
      clusterId,
      eventId: event.eventId,
      eventType: event.type,
      severity: event.severity
    }, '[EventHandler] Event received');

    try {
      // Store event in database
      await this.storeEvent(clusterId, event);

      // Process event based on type
      await this.processEvent(clusterId, event);

      // Log based on severity
      this.logEvent(clusterId, event);
    } catch (error) {
      logger.error({
        error,
        clusterId,
        eventId: event.eventId
      }, '[EventHandler] Error handling event');
    }
  }

  /**
   * Store event in database
   */
  private async storeEvent(clusterId: string, event: any): Promise<void> {
    try {
      const prisma = await prismaManager.getClient();
      await (prisma as any).event.create({
        data: {
          eventId: event.eventId,
          clusterId,
          eventType: event.type,
          severity: event.severity,
          source: event.source,
          timestamp: event.timestamp ? new Date(event.timestamp as any) : new Date(),
          payload: event.payload || {},
          metadata: event.metadata || {}
        }
      });
    } catch (error) {
      logger.error({
        error,
        eventId: event.eventId
      }, '[EventHandler] Failed to store event');
    }
  }

  /**
   * Process event based on type
   */
  private async processEvent(clusterId: string, event: Event): Promise<void> {
    switch (event.type) {
      case 'EVENT_TYPE_CONNECTED':
        await this.handleConnectionEvent(clusterId, event, 'CONNECTED');
        break;

      case 'EVENT_TYPE_DISCONNECTED':
        await this.handleConnectionEvent(clusterId, event, 'DISCONNECTED');
        break;

      case 'EVENT_TYPE_AGENT_CREATED':
      case 'EVENT_TYPE_AGENT_DELETED':
      case 'EVENT_TYPE_AGENT_UPDATED':
        await this.handleAgentEvent(clusterId, event);
        break;

      case 'EVENT_TYPE_ERROR':
        await this.handleErrorEvent(clusterId, event);
        break;

      case 'EVENT_TYPE_HEALTH_STATUS':
        await this.handleHealthEvent(clusterId, event);
        break;

      default:
        logger.debug({
          clusterId,
          eventType: event.type
        }, '[EventHandler] Unhandled event type');
    }
  }

  /**
   * Handle connection events
   */
  private async handleConnectionEvent(
    clusterId: string,
    _event: Event,
    state: string
  ): Promise<void> {
    try {
      const prisma = await prismaManager.getClient();
      await prisma.cluster.update({
        where: { id: clusterId },
        data: {
          status: state === 'CONNECTED' ? 'ACTIVE' : 'INACTIVE',
          lastHeartbeat: new Date()
        }
      });

      logger.info({
        clusterId,
        state
      }, '[EventHandler] Connection state updated');
    } catch (error) {
      logger.error({
        error,
        clusterId
      }, '[EventHandler] Failed to update connection state');
    }
  }

  /**
   * Handle agent events
   */
  private async handleAgentEvent(clusterId: string, event: Event): Promise<void> {
    logger.info({
      clusterId,
      eventType: event.type,
      payload: event.payload
    }, '[EventHandler] Agent event');

    // Additional agent-specific processing can be added here
  }

  /**
   * Handle error events
   */
  private async handleErrorEvent(clusterId: string, event: Event): Promise<void> {
    logger.error({
      clusterId,
      eventId: event.eventId,
      payload: event.payload
    }, '[EventHandler] Error event from cluster');

    // Could trigger alerts, notifications, etc.
  }

  /**
   * Handle health events
   */
  private async handleHealthEvent(clusterId: string, event: Event): Promise<void> {
    try {
      const prisma = await prismaManager.getClient();
      await prisma.cluster.update({
        where: { id: clusterId },
        data: {
          lastHeartbeat: new Date(),
          relayerConfig: event.payload || {}
        }
      });
    } catch (error) {
      logger.error({
        error,
        clusterId
      }, '[EventHandler] Failed to update health status');
    }
  }

  /**
   * Log event based on severity
   */
  private logEvent(clusterId: string, event: Event): void {
    const logData = {
      clusterId,
      eventId: event.eventId,
      type: event.type,
      source: event.source
    };

    switch (event.severity) {
      case 'EVENT_SEVERITY_CRITICAL':
      case 'EVENT_SEVERITY_ERROR':
        logger.error(logData, '[EventHandler] High severity event');
        break;

      case 'EVENT_SEVERITY_WARNING':
        logger.warn(logData, '[EventHandler] Warning event');
        break;

      case 'EVENT_SEVERITY_INFO':
        logger.info(logData, '[EventHandler] Info event');
        break;

      case 'EVENT_SEVERITY_DEBUG':
      default:
        logger.debug(logData, '[EventHandler] Debug event');
    }
  }
}