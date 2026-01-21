/**
 * @fileoverview Agent API Routes
 * @module routes/agents
 * 
 * Provides endpoints for managing agents and their executions.
 * All routes here require organization-level authentication.
 */

import { FastifyInstance } from 'fastify';
import { 
    registerAgents, 
    listAgents, 
    executeAgent, 
    getExecutionStatus 
} from '../controllers/agents.controller.js';

/**
 * Register Agent-specific API routes.
 * 
 * ROUTES:
 * - POST /api/agents/register: Unified agent registration (upsert)
 * - GET  /api/agents: List organization agents
 * - POST /api/execute: Initiate agent execution
 * - GET  /api/executions/:executionId: Fetch execution status/result
 * 
 * @param fastify - Fastify instance
 */
export async function agentRoutes(fastify: FastifyInstance) {
    // --------------------------------------------------------------------------
    // Agent Management
    // --------------------------------------------------------------------------

    // POST /api/agents/register - Register Agents (Unified)
    fastify.post<{ Body: any }>('/api/agents/register', registerAgents);

    // GET /api/agents - List Agents
    fastify.get<{ Querystring: { name?: string } }>('/api/agents', listAgents);

    // --------------------------------------------------------------------------
    // Execution Orchestration
    // --------------------------------------------------------------------------

    // POST /api/execute - Execute Agent
    fastify.post<{ Body: any }>('/api/execute', executeAgent);

    // GET /api/executions/:executionId - Execution Status
    fastify.get<{ Params: { executionId: string } }>('/api/executions/:executionId', getExecutionStatus);
}