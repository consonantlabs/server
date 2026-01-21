/**
 * @fileoverview Telemetry Query Service
 * @module services/telemetry
 * 
 * Provides methods for querying telemetry data (traces, metrics, logs)
 * from TimescaleDB.
 */

import { PrismaClient } from '@prisma/client';
import { PAGINATION } from '@/config/constants.js';

export class TelemetryService {
    constructor(private timescale: PrismaClient) { }

    /**
     * List traces with filtering and pagination.
     */
    async listTraces(organizationId: string, filters: any) {
        const {
            startTime,
            endTime,
            traceId,
            spanId,
            serviceName,
            limit = PAGINATION.DEFAULT_LIMIT,
            offset = PAGINATION.DEFAULT_OFFSET,
        } = filters;

        const where: any = { organizationId };

        if (startTime || endTime) {
            where.timestamp = {};
            if (startTime) where.timestamp.gte = new Date(startTime);
            if (endTime) where.timestamp.lte = new Date(endTime);
        }

        if (traceId) where.traceId = traceId;
        if (spanId) where.spanId = spanId;
        if (serviceName) {
            where.resource = {
                path: ['service', 'name'],
                equals: serviceName,
            };
        }

        const [traces, total] = await Promise.all([
            this.timescale.trace.findMany({
                where,
                orderBy: { timestamp: 'desc' },
                take: Math.min(limit, PAGINATION.MAX_LIMIT),
                skip: offset,
            }),
            this.timescale.trace.count({ where }),
        ]);

        return { traces, total };
    }

    /**
     * Get a full trace tree by ID.
     */
    async getTrace(organizationId: string, traceId: string) {
        return this.timescale.trace.findMany({
            where: { organizationId, traceId },
            orderBy: { timestamp: 'asc' },
        });
    }

    /**
     * List metrics with filtering and pagination.
     */
    async listMetrics(organizationId: string, filters: any) {
        const {
            startTime,
            endTime,
            name,
            type,
            limit = PAGINATION.DEFAULT_LIMIT,
            offset = PAGINATION.DEFAULT_OFFSET,
        } = filters;

        const where: any = { organizationId };

        if (startTime || endTime) {
            where.timestamp = {};
            if (startTime) where.timestamp.gte = new Date(startTime);
            if (endTime) where.timestamp.lte = new Date(endTime);
        }

        if (name) where.name = name;
        if (type) where.type = type;

        const [metrics, total] = await Promise.all([
            this.timescale.metric.findMany({
                where,
                orderBy: { timestamp: 'desc' },
                take: Math.min(limit, PAGINATION.MAX_LIMIT),
                skip: offset,
            }),
            this.timescale.metric.count({ where }),
        ]);

        return { metrics, total };
    }

    /**
     * List logs with filtering and pagination.
     */
    async listLogs(organizationId: string, filters: any) {
        const {
            startTime,
            endTime,
            severity,
            search,
            limit = PAGINATION.DEFAULT_LIMIT,
            offset = PAGINATION.DEFAULT_OFFSET,
        } = filters;

        const where: any = { organizationId };

        if (startTime || endTime) {
            where.timestamp = {};
            if (startTime) where.timestamp.gte = new Date(startTime);
            if (endTime) where.timestamp.lte = new Date(endTime);
        }

        if (severity) where.severity = severity;
        if (search) where.message = { contains: search, mode: 'insensitive' };

        const [logs, total] = await Promise.all([
            this.timescale.log.findMany({
                where,
                orderBy: { timestamp: 'desc' },
                take: Math.min(limit, PAGINATION.MAX_LIMIT),
                skip: offset,
            }),
            this.timescale.log.count({ where }),
        ]);

        return { logs, total };
    }
}

let telemetryServiceInstance: TelemetryService | null = null;

export function initTelemetryService(timescale: PrismaClient): void {
    telemetryServiceInstance = new TelemetryService(timescale);
}

export function getTelemetryService(): TelemetryService {
    if (!telemetryServiceInstance) {
        throw new Error('TelemetryService not initialized');
    }
    return telemetryServiceInstance;
}
