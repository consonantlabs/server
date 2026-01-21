/**
 * @fileoverview SDK Controller
 * @module controllers/sdk
 * 
 * Handles HTTP-level logic for the Consonant SDK:
 * - Agent registration (delegates to AgentService)
 * - Agent execution (delegates to Orchestration services)
 * - Execution status (delegates to Prisma/Service)
 */

import { FastifyRequest, FastifyReply } from 'fastify';
import { getAgentService } from '../services/agent.service.js';
import { logger } from '../utils/logger.js';
import { AgentStatus } from '@prisma/client';

/**
 * Register Agents (Unified Batch Hook).
 * 
 * Returns 202 ACCEPTED immediately with PENDING status.
 * Actual provisioning (clustering, preparation) is handled asynchronously.
 */
export async function registerAgents(
    request: FastifyRequest<{ Body: any }>,
    reply: FastifyReply
): Promise<void> {
    const organizationId = (request as any).organizationId;
    const body = request.body as any;

    // Normalize input
    const configs = Array.isArray(body.agents) ? body.agents : (Array.isArray(body) ? body : [body]);

    if (configs.length === 0) {
        return reply.code(400).send({ success: false, error: 'No agents provided' });
    }

    try {
        const agentService = getAgentService();
        const results = await agentService.registerAgents(organizationId, configs);

        // Filter results to only successful/processed ones for the aggregate response
        const someSuccess = results.some(r => r.status === 'success');

        return reply.code(202).send({
            success: someSuccess,
            message: 'Agent registration requests accepted and are pending.',
            results,
        });
    } catch (error: any) {
        logger.error({ error, organizationId }, 'Agent Controller: Registration failed');
        return reply.code(500).send({ success: false, error: 'Internal server error' });
    }
}

/**
 * List agents with optional name filtering.
 */
export async function listAgents(
    request: FastifyRequest<{ Querystring: { name?: string } }>,
    reply: FastifyReply
): Promise<void> {
    const organizationId = (request as any).organizationId;
    const { name } = request.query;

    try {
        const service = getAgentService();
        if (name) {
            const agent = await service.get(organizationId, name);
            return reply.send({ success: true, agents: agent ? [agent] : [] });
        }

        const agents = await service.list(organizationId);
        return reply.send({ success: true, agents });
    } catch (error) {
        logger.error({ error, organizationId }, 'Agent Controller: List failed');
        return reply.code(500).send({ success: false, error: 'Internal server error' });
    }
}

/**
 * Execute an agent.
 */
export async function executeAgent(
    request: FastifyRequest<{ Body: any }>,
    reply: FastifyReply
): Promise<void> {
    const { agent: agentName, input, priority = 'normal' } = request.body as any;
    const organizationId = (request as any).organizationId;

    try {
        const service = getAgentService();
        const agent = await service.get(organizationId, agentName);

        if (!agent) {
            return reply.code(404).send({ success: false, error: 'Agent not found' });
        }

        // Agent must be ACTIVE to be executed
        if (agent.status !== AgentStatus.ACTIVE) {
            return reply.code(400).send({
                success: false,
                error: 'Agent not ready',
                message: `Agent is in ${agent.status} state. Wait for registration to complete.`,
            });
        }

        const execution = await service.executeAgent({
            agentId: agent.id,
            organizationId,
            input: input || {},
            priority: priority as any,
        });

        return reply.code(202).send({
            success: true,
            executionId: execution.id,
            status: execution.status,
        });
    } catch (error: any) {
        logger.error({ error, organizationId, agentName }, 'Agent Controller: Execution failed');
        return reply.code(500).send({ success: false, error: 'Internal server error', message: error.message });
    }
}

/**
 * Get detailed execution status and result.
 */
export async function getExecutionStatus(
    request: FastifyRequest<{ Params: { executionId: string } }>,
    reply: FastifyReply
): Promise<void> {
    const organizationId = (request as any).organizationId;
    const { executionId } = request.params;

    try {
        const service = getAgentService();
        const execution = await service.getExecution(organizationId, executionId);

        if (!execution) {
            return reply.code(404).send({ success: false, error: 'Execution not found or access denied' });
        }

        return reply.send({
            success: true,
            data: {
                id: execution.id,
                status: execution.status,
                result: execution.result,
                error: execution.error,
                durationMs: execution.durationMs,
                createdAt: execution.createdAt,
            },
        });
    } catch (error) {
        logger.error({ error, executionId }, 'Agent Controller: Get status failed');
        return reply.code(500).send({ success: false, error: 'Internal server error' });
    }
}
