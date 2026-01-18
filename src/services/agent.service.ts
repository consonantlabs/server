/**
 * @fileoverview Agent Registry Service
 * @module services/agent-registry
 * 
 * This service manages the agent registry - the catalog of agents that
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

import { PrismaClient, Agent, Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { logger } from '../utils/logger.js';
import type { AgentConfig } from './inngest/events.js';

// Agent status values are imported from @prisma/client
import { AgentStatus } from '@prisma/client';

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
   * Register or update an agent.
   * 
   * Uses upsert semantics: creates the agent if it doesn't exist,
   * updates it if the config has changed (detected via config hash).
   * 
   * @param organizationId - Which organization owns this agent
   * @param config - Agent configuration
   * @returns Object with agent record and whether it was created/updated
   */
  async registerOrUpdate(
    organizationId: string,
    config: AgentConfig
  ): Promise<{ agent: Agent; action: 'created' | 'updated' | 'unchanged' }> {
    // Validate configuration before saving
    this.validateConfig(config);

    const configHash = generateConfigHash(config);

    try {
      // Check if agent with this name exists
      const existingAgent = await this.prisma.agent.findUnique({
        where: {
          organizationId_name: {
            organizationId,
            name: config.name,
          },
        },
      });

      if (existingAgent) {
        // Agent exists - check if config changed
        if (existingAgent.configHash === configHash) {
          logger.debug({
            agentId: existingAgent.id,
            agentName: config.name,
          }, 'Agent config unchanged, skipping update');

          return { agent: existingAgent, action: 'unchanged' };
        }

        // Config changed - update the agent
        const updatedAgent = await this.prisma.agent.update({
          where: { id: existingAgent.id },
          data: {
            image: config.image,
            description: config.description,
            resources: config.resources as Prisma.InputJsonValue,
            retryPolicy: config.retryPolicy as Prisma.InputJsonValue,
            useAgentSandbox: config.useAgentSandbox ?? false,
            warmPoolSize: config.warmPoolSize ?? 0,
            networkPolicy: config.networkPolicy ?? 'standard',
            environmentVariables: config.environmentVariables as Prisma.InputJsonValue,
            configHash,
            status: AgentStatus.PENDING, // Reset to pending for re-registration
          },
        });

        logger.info({
          agentId: updatedAgent.id,
          agentName: config.name,
          organizationId,
        }, 'Agent updated with new config');

        return { agent: updatedAgent, action: 'updated' };
      }

      // Create new agent
      const newAgent = await this.prisma.agent.create({
        data: {
          organizationId,
          name: config.name,
          image: config.image,
          description: config.description,
          resources: config.resources as Prisma.InputJsonValue,
          retryPolicy: config.retryPolicy as Prisma.InputJsonValue,
          useAgentSandbox: config.useAgentSandbox ?? false,
          warmPoolSize: config.warmPoolSize ?? 0,
          networkPolicy: config.networkPolicy ?? 'standard',
          environmentVariables: config.environmentVariables as Prisma.InputJsonValue,
          configHash,
          status: AgentStatus.PENDING,
        },
      });

      logger.info({
        agentId: newAgent.id,
        agentName: config.name,
        organizationId,
      }, 'Agent registered');

      return { agent: newAgent, action: 'created' };
    } catch (error) {
      logger.error({
        error,
        organizationId,
        agentName: config.name,
      }, 'Failed to register/update agent');

      throw new Error(`Failed to register agent: ${error}`);
    }
  }

  /**
   * Register or update a list of agents.
   * 
   * Useful for bulk onboarding or syncing agent catalogs from CI/CD.
   * 
   * @param organizationId - Which organization owns these agents
   * @param configs - Array of agent configurations
   * @returns Array of registration results
   */
  async bulkRegisterOrUpdate(
    organizationId: string,
    configs: AgentConfig[]
  ): Promise<Array<{ agent: Agent; action: 'created' | 'updated' | 'unchanged' }>> {
    const results = [];
    
    for (const config of configs) {
      const result = await this.registerOrUpdate(organizationId, config);
      results.push(result);
    }
    
    return results;
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