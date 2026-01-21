/**
 * @fileoverview Agent Registry Service
 * @module services/agent
 * 
 * This service manages the registered agents - the catalog of agents that
 * customers have registered and can execute. Each agent defines a Docker
 * container image and execution configuration.
 * 
 * ARCHITECTURAL ROLE:
 * The agent registry is consulted during execution to fetch the agent's
 * configuration (image URL, resources, retry policy). This happens on the
 * hot path, so queries are optimized with strategic indexes.
 * 
 * KEY FEATURES:
 * - Canonical hashing for config diffing (upsert behavior)
 * - Organization-scoped agents (not API key scoped)
 * - Status tracking: pending → active → failed
 */

import { PrismaClient, Agent, Prisma, Execution } from '@prisma/client';
import { createHash } from 'crypto';
import { logger } from '../utils/logger.js';
import type { AgentConfig } from './inngest/events.js';
import { inngest } from './inngest/client.js';
import { generateUUID } from '../utils/crypto.js';

// Agent status values are imported from @prisma/client
import { AgentStatus } from '@prisma/client';

export interface ExecutionRequest {
  agentId: string;
  organizationId: string;
  input: Record<string, unknown>;
  priority?: 'low' | 'normal' | 'high';
}

/**
 * Generate a canonical hash for an agent configuration.
 * Used for detecting changes during upsert operations.
 * 
 * The hash is computed from a deterministic JSON representation of:
 * - name, image, resources, retryPolicy
 * 
 * @param config - Agent configuration
 * @returns SHA-256 hash string
 */
export function generateConfigHash(config: AgentConfig): string {
  // Create a canonical representation for hashing
  const canonical = {
    name: config.name,
    image: config.image,
    resources: config.resources,
    retryPolicy: config.retryPolicy,
    useAgentSandbox: config.useAgentSandbox ?? false,
    warmPoolSize: config.warmPoolSize ?? 0,
    networkPolicy: config.networkPolicy ?? 'standard',
  };

  // Sort keys for deterministic JSON
  const sortedJson = JSON.stringify(canonical, Object.keys(canonical).sort());

  return createHash('sha256').update(sortedJson).digest('hex');
}

/**
 * Agent Registry Service
 * 
 * Provides type-safe operations for managing agent definitions.
 * All operations are scoped to an organization, ensuring customers can only
 * access their own agents.
 */
export class AgentService {
  constructor(private prisma: PrismaClient) { }

  /**
   * Register or update multiple agents in a single operation.
   * This is the unified entry point for all agent registrations.
   * 
   * @param organizationId - Owning organization
   * @param configs - Array of agent configurations
   * @returns Array of registration results
   */
  async registerAgents(
    organizationId: string,
    configs: AgentConfig[]
  ): Promise<Array<{ name: string; status: 'success' | 'failed'; agentId?: string; error?: string }>> {
    logger.info({ organizationId, count: configs.length }, 'Starting agent registration batch');

    // Process in parallel for performance.
    // The underlying private `registerOrUpdate` handles individual agent logic.
    const tasks = configs.map(async (config) => {
      try {
        // Validate configuration before saving
        this.validateConfig(config);

        const { agent, action } = await this.upsertAgent(organizationId, config);

        // Emit event to Inngest for registration workflow (unless unchanged)
        // ARCHITECTURAL DESIGN: Durable Registration
        // We use Inngest to handle the heavy lifting (Sandboxing, preparation)
        // asynchronously after the DB record is secured.
        if (action !== 'unchanged') {
          await inngest.send({
            name: 'agent.registration.requested',
            data: {
              organizationId,
              config: config as any,
              requestId: `reg-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
              requestedAt: new Date().toISOString(),
            },
          });
        }

        return {
          name: config.name,
          status: 'success' as const,
          agentId: agent.id
        };
      } catch (error: any) {
        logger.error({ error, organizationId, name: config.name }, 'Individual agent registration failed in batch');
        return {
          name: config.name,
          status: 'failed' as const,
          error: error.message
        };
      }
    });

    return Promise.all(tasks);
  }

  /**
   * Internal: Register or update a single agent in the database.
   * 
   * @param organizationId - Owning organization
   * @param config - Agent configuration
   * @returns The agent record and the action taken
   */
  async upsertAgent(
    organizationId: string,
    config: AgentConfig
  ): Promise<{ agent: Agent; action: 'created' | 'updated' | 'unchanged' }> {
    const configHash = generateConfigHash(config);

    try {
      // 1. Check if agent exists
      const existingAgent = await this.prisma.agent.findUnique({
        where: {
          organizationId_name: { organizationId, name: config.name },
        },
      });

      // 2. Handle creation/update based on hash
      if (!existingAgent) {
        const agent = await this.prisma.agent.create({
          data: {
            organizationId,
            name: config.name,
            image: config.image,
            description: config.description,
            configHash,
            resources: config.resources as Prisma.InputJsonValue,
            retryPolicy: config.retryPolicy as Prisma.InputJsonValue,
            useAgentSandbox: config.useAgentSandbox ?? false,
            warmPoolSize: config.warmPoolSize ?? 0,
            networkPolicy: config.networkPolicy ?? 'standard',
            environmentVariables: config.environmentVariables as Prisma.InputJsonValue || {},
            status: AgentStatus.PENDING,
          },
        });

        logger.info({ organizationId, agentName: config.name, agentId: agent.id }, 'Agent created');
        return { agent, action: 'created' };
      }

      if (existingAgent.configHash !== configHash) {
        const agent = await this.prisma.agent.update({
          where: { id: existingAgent.id },
          data: {
            image: config.image,
            description: config.description,
            configHash,
            resources: config.resources as Prisma.InputJsonValue,
            retryPolicy: config.retryPolicy as Prisma.InputJsonValue,
            useAgentSandbox: config.useAgentSandbox ?? false,
            warmPoolSize: config.warmPoolSize ?? 0,
            networkPolicy: config.networkPolicy ?? 'standard',
            environmentVariables: config.environmentVariables as Prisma.InputJsonValue || {},
            status: AgentStatus.PENDING,
            registrationReport: Prisma.DbNull,
          },
        });

        logger.info({ organizationId, agentName: config.name, agentId: agent.id }, 'Agent updated');
        return { agent, action: 'updated' };
      }

      return { agent: existingAgent, action: 'unchanged' };
    } catch (error) {
      logger.error({ error, organizationId, name: config.name }, 'Failed to register/update agent in DB');
      throw error;
    }
  }

  /**
   * Handle registration status update from relayer.
   * Called by the gRPC EventHandler when the relayer provides feedback on agent provisioning.
   * 
   * This is idempotent: it only updates if the status is actually changing or providing new info.
   */
  async handleRegistrationStatus(
    agentId: string,
    clusterId: string,
    status: AgentStatus,
    error?: string
  ): Promise<void> {
    await this.prisma.agentClusterStatus.upsert({
      where: {
        agentId_clusterId: { agentId, clusterId }
      },
      update: { status, error, updatedAt: new Date() },
      create: { agentId, clusterId, status, error }
    });

    // ARCHITECTURAL DESIGN: Global Status Aggregation
    // If targeted cluster fails, the global status reflects it.
    await this.aggregateGlobalStatus(agentId);

    // Emit event to Inngest to notify any waiters or update frontend
    await inngest.send({
      name: 'agent.registration.status_updated',
      data: {
        agentId,
        clusterId,
        status: status as any,
        error,
        timestamp: new Date().toISOString()
      }
    });
  }

  /**
   * Aggregate statuses from all clusters to form a global agent status.
   */
  private async aggregateGlobalStatus(agentId: string): Promise<void> {
    const statuses = await this.prisma.agentClusterStatus.findMany({
      where: { agentId }
    });

    if (statuses.length === 0) return;

    let globalStatus: AgentStatus = AgentStatus.ACTIVE;
    const report: Record<string, any> = {};

    for (const s of statuses) {
      report[s.clusterId] = { status: s.status, error: s.error };
      if (s.status === 'FAILED') globalStatus = AgentStatus.FAILED;
      else if (s.status === 'PENDING' && globalStatus !== 'FAILED') {
        globalStatus = AgentStatus.PENDING;
      }
    }

    await this.prisma.agent.update({
      where: { id: agentId },
      data: {
        status: globalStatus,
        registrationReport: report as Prisma.InputJsonValue
      }
    });
  }

  /**
   * Update agent status.
   * Called when relayer acknowledges registration or reports failure.
   * 
   * @param agentId - Agent to update
   * @param status - New status
   */
  async updateStatus(agentId: string, status: AgentStatus): Promise<Agent> {
    return this.prisma.agent.update({
      where: { id: agentId },
      data: { status },
    });
  }

  /**
   * Get an agent by name or ID.
   * 
   * This is called on the hot path during execution, so it's optimized
   * with an index on (organizationId, name).
   * 
   * @param organizationId - Which organization owns this agent
   * @param nameOrId - Agent name or UUID
   * @returns Agent if found, null otherwise
   */
  async get(organizationId: string, nameOrId: string): Promise<Agent | null> {
    try {
      // Try to find by ID first (if it looks like a UUID)
      if (nameOrId.match(/^[0-9a-f-]{36}$/i)) {
        const agent = await this.prisma.agent.findFirst({
          where: {
            id: nameOrId,
            organizationId,
          },
        });
        if (agent) return agent;
      }

      // Fall back to name lookup (uses the unique index)
      return await this.prisma.agent.findUnique({
        where: {
          organizationId_name: {
            organizationId,
            name: nameOrId,
          },
        },
      });
    } catch (error) {
      logger.error({
        error,
        organizationId,
        nameOrId,
      }, 'Failed to get agent');
      return null;
    }
  }

  /**
   * List all agents for an organization.
   * 
   * Returns agents in reverse chronological order (newest first).
   * 
   * @param organizationId - Which organization's agents to list
   * @param limit - Maximum number to return
   * @param offset - Skip this many agents (for pagination)
   * @returns Array of agents
   */
  async list(
    organizationId: string,
    limit: number = 50,
    offset: number = 0
  ): Promise<Agent[]> {
    try {
      return await this.prisma.agent.findMany({
        where: { organizationId },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      });
    } catch (error) {
      logger.error({
        error,
        organizationId,
      }, 'Failed to list agents');
      return [];
    }
  }

  /**
   * Delete an agent.
   * 
   * Cascades to delete all execution records for this agent.
   * This is a destructive operation and should be used carefully.
   * 
   * @param organizationId - Which organization owns this agent
   * @param agentId - Agent to delete
   * @throws Error if agent not found or doesn't belong to this organization
   */
  async delete(organizationId: string, agentId: string): Promise<void> {
    // Verify ownership
    const existing = await this.get(organizationId, agentId);
    if (!existing) {
      throw new Error('Agent not found or access denied');
    }

    try {
      await this.prisma.agent.delete({
        where: { id: agentId },
      });

      logger.info({ agentId }, 'Agent deleted');
    } catch (error) {
      logger.error({
        error,
        agentId,
      }, 'Failed to delete agent');
      throw new Error(`Failed to delete agent: ${error}`);
    }
  }

  /**
   * Initiate a new agent execution.
   */
  async executeAgent(request: ExecutionRequest): Promise<Execution> {
    const { agentId, organizationId, input, priority = 'normal' } = request;
    const executionId = generateUUID();

    try {
      const agent = await this.prisma.agent.findUnique({
        where: { id: agentId },
        select: { retryPolicy: true, status: true }
      });

      if (!agent) throw new Error('Agent not found');
      if (agent.status !== AgentStatus.ACTIVE) {
        throw new Error(`Agent is not active (Status: ${agent.status})`);
      }

      const maxAttempts = (agent.retryPolicy as any)?.maxAttempts || 3;

      const execution = await this.prisma.execution.create({
        data: {
          id: executionId,
          agentId,
          status: 'PENDING',
          input: (input || {}) as Prisma.InputJsonValue,
          priority: priority.toUpperCase() as any,
          maxAttempts,
        }
      });

      await inngest.send({
        name: 'agent.execution.requested',
        data: {
          executionId,
          agentId,
          organizationId,
          input,
          priority,
          requestedAt: new Date().toISOString(),
        },
      });

      logger.info({ executionId, agentId, organizationId }, 'Execution initiated successfully');
      return execution;
    } catch (error) {
      logger.error({ error, agentId, organizationId }, 'Failed to initiate execution');
      throw error;
    }
  }

  /**
   * Get execution details by ID.
   */
  async getExecution(organizationId: string, executionId: string): Promise<Execution | null> {
    const execution = await this.prisma.execution.findUnique({
      where: { id: executionId },
      include: { agent: { select: { organizationId: true } } }
    });

    if (!execution || execution.agent.organizationId !== organizationId) {
      return null;
    }

    return execution;
  }

  /**
   * Update execution status and result.
   */
  async updateExecution(executionId: string, data: any): Promise<Execution> {
    return this.prisma.execution.update({
      where: { id: executionId },
      data,
    });
  }

  /**
   * Validate agent configuration before saving.
   * 
   * Ensures resource specs are valid, retry policy makes sense, etc.
   * Throws with helpful error messages if validation fails.
   * 
   * @param config - Agent configuration to validate
   * @throws Error if configuration is invalid
   */
  private validateConfig(config: AgentConfig): void {
    // Validate agent name
    if (!config.name || config.name.length === 0) {
      throw new Error('Agent name is required');
    }
    if (config.name.length > 100) {
      throw new Error('Agent name must be 100 characters or less');
    }
    if (!/^[a-z0-9-]+$/.test(config.name)) {
      throw new Error('Agent name must contain only lowercase letters, numbers, and hyphens');
    }

    // Validate image URL
    if (!config.image || config.image.length === 0) {
      throw new Error('Agent image is required');
    }
    // Basic Docker image URL validation
    if (!config.image.includes('/') || !config.image.includes(':')) {
      throw new Error('Agent image must be a valid Docker image URL (e.g., docker.io/company/image:tag)');
    }

    // Validate resources
    if (!config.resources) {
      throw new Error('Resource requirements are required');
    }
    if (!config.resources.cpu || !config.resources.memory || !config.resources.timeout) {
      throw new Error('CPU, memory, and timeout are required resource specs');
    }

    // Validate retry policy
    if (!config.retryPolicy) {
      throw new Error('Retry policy is required');
    }
    if (config.retryPolicy.maxAttempts < 1 || config.retryPolicy.maxAttempts > 10) {
      throw new Error('Retry maxAttempts must be between 1 and 10');
    }
    if (!['exponential', 'linear', 'constant'].includes(config.retryPolicy.backoff)) {
      throw new Error('Retry backoff must be exponential, linear, or constant');
    }

    // Validate warm pool size if specified
    if (config.warmPoolSize !== undefined && config.warmPoolSize < 0) {
      throw new Error('Warm pool size cannot be negative');
    }
    if (config.warmPoolSize !== undefined && config.warmPoolSize > 100) {
      throw new Error('Warm pool size cannot exceed 100 instances');
    }

    // Validate network policy if specified
    if (config.networkPolicy && !['restricted', 'standard', 'unrestricted'].includes(config.networkPolicy)) {
      throw new Error('Network policy must be restricted, standard, or unrestricted');
    }
  }
}

/**
 * Singleton instance of the agent registry service.
 * Initialized in server.ts with the Prisma client.
 */
let agentServiceInstance: AgentService | null = null;

/**
 * Initialize the agent service.
 * 
 * @param prisma - Prisma client instance
 */
export function initAgentService(prisma: PrismaClient): void {
  agentServiceInstance = new AgentService(prisma);
  logger.info('Agent service initialized');
}

/**
 * Get the agent service instance.
 * 
 * @returns AgentService instance
 * @throws Error if not initialized
 */
export function getAgentService(): AgentService {
  if (!agentServiceInstance) {
    throw new Error('Agent service not initialized. Call initAgentService() first.');
  }
  return agentServiceInstance;
}