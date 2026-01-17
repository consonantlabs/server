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
 */

import { PrismaClient, Agent, Prisma } from '@prisma/client';
import { logger } from '../utils/logger.js';
import type { AgentConfig } from './inngest/events.js';

/**
 * Agent Registry Service
 * 
 * Provides type-safe operations for managing agent definitions.
 * All operations are scoped to an API key, ensuring customers can only
 * access their own agents.
 */
export class AgentRegistryService {
  constructor(private prisma: PrismaClient) {}

  /**
   * Register a new agent.
   * 
   * Creates an agent definition that can be executed multiple times.
   * Agent names must be unique within an API key's namespace.
   * 
   * @param apiKeyId - Which API key owns this agent
   * @param config - Agent configuration
   * @returns Created agent record
   * @throws Error if agent name already exists for this API key
   */
  async register(apiKeyId: string, config: AgentConfig): Promise<Agent> {
    // Validate configuration before saving
    this.validateConfig(config);

    try {
      const agent = await this.prisma.agent.create({
        data: {
          apiKeyId,
          name: config.name,
          image: config.image,
          description: config.description,
          resources: config.resources as Prisma.InputJsonValue,
          retryPolicy: config.retryPolicy as Prisma.InputJsonValue,
          useAgentSandbox: config.useAgentSandbox ?? false,
          warmPoolSize: config.warmPoolSize ?? 0,
          networkPolicy: config.networkPolicy ?? 'standard',
          environmentVariables: config.environmentVariables as Prisma.InputJsonValue,
        },
      });

      logger.info({
        agentId: agent.id,
        agentName: agent.name,
        apiKeyId,
      }, 'Agent registered');

      return agent;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === 'P2002') {
          // Unique constraint violation - agent name already exists
          throw new Error(`Agent with name "${config.name}" already exists`);
        }
      }
      
      logger.error({
        error,
        apiKeyId,
        agentName: config.name,
      }, 'Failed to register agent');
      
      throw new Error(`Failed to register agent: ${error}`);
    }
  }

  /**
   * Get an agent by name or ID.
   * 
   * This is called on the hot path during execution, so it's optimized
   * with an index on (apiKeyId, name).
   * 
   * @param apiKeyId - Which API key owns this agent
   * @param nameOrId - Agent name or UUID
   * @returns Agent if found, null otherwise
   */
  async get(apiKeyId: string, nameOrId: string): Promise<Agent | null> {
    try {
      // Try to find by ID first (if it looks like a UUID)
      if (nameOrId.match(/^[0-9a-f-]{36}$/i)) {
        const agent = await this.prisma.agent.findFirst({
          where: {
            id: nameOrId,
            apiKeyId,
          },
        });
        if (agent) return agent;
      }

      // Fall back to name lookup (uses the unique index)
      return await this.prisma.agent.findUnique({
        where: {
          apiKeyId_name: {
            apiKeyId,
            name: nameOrId,
          },
        },
      });
    } catch (error) {
      logger.error({
        error,
        apiKeyId,
        nameOrId,
      }, 'Failed to get agent');
      return null;
    }
  }

  /**
   * List all agents for an API key.
   * 
   * Returns agents in reverse chronological order (newest first).
   * 
   * @param apiKeyId - Which API key's agents to list
   * @param limit - Maximum number to return
   * @param offset - Skip this many agents (for pagination)
   * @returns Array of agents
   */
  async list(
    apiKeyId: string,
    limit: number = 50,
    offset: number = 0
  ): Promise<Agent[]> {
    try {
      return await this.prisma.agent.findMany({
        where: { apiKeyId },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      });
    } catch (error) {
      logger.error({
        error,
        apiKeyId,
      }, 'Failed to list agents');
      return [];
    }
  }

  /**
   * Update an agent's configuration.
   * 
   * Allows changing resource requirements, retry policy, and advanced features.
   * The agent image can also be updated (useful for deploying new versions).
   * 
   * @param apiKeyId - Which API key owns this agent
   * @param agentId - Agent to update
   * @param changes - Configuration changes
   * @returns Updated agent
   * @throws Error if agent not found or doesn't belong to this API key
   */
  async update(
    apiKeyId: string,
    agentId: string,
    changes: Partial<AgentConfig>
  ): Promise<Agent> {
    // Verify ownership
    const existing = await this.get(apiKeyId, agentId);
    if (!existing) {
      throw new Error('Agent not found or access denied');
    }

    try {
      const agent = await this.prisma.agent.update({
        where: { id: agentId },
        data: {
          ...(changes.name && { name: changes.name }),
          ...(changes.image && { image: changes.image }),
          ...(changes.description !== undefined && { description: changes.description }),
          ...(changes.resources && { resources: changes.resources as Prisma.InputJsonValue }),
          ...(changes.retryPolicy && { retryPolicy: changes.retryPolicy as Prisma.InputJsonValue }),
          ...(changes.useAgentSandbox !== undefined && { useAgentSandbox: changes.useAgentSandbox }),
          ...(changes.warmPoolSize !== undefined && { warmPoolSize: changes.warmPoolSize }),
          ...(changes.networkPolicy && { networkPolicy: changes.networkPolicy }),
          ...(changes.environmentVariables !== undefined && { 
            environmentVariables: changes.environmentVariables as Prisma.InputJsonValue 
          }),
        },
      });

      logger.info({
        agentId,
        changes: Object.keys(changes),
      }, 'Agent updated');

      return agent;
    } catch (error) {
      logger.error({
        error,
        agentId,
      }, 'Failed to update agent');
      throw new Error(`Failed to update agent: ${error}`);
    }
  }

  /**
   * Delete an agent.
   * 
   * Cascades to delete all execution records for this agent.
   * This is a destructive operation and should be used carefully.
   * 
   * @param apiKeyId - Which API key owns this agent
   * @param agentId - Agent to delete
   * @throws Error if agent not found or doesn't belong to this API key
   */
  async delete(apiKeyId: string, agentId: string): Promise<void> {
    // Verify ownership
    const existing = await this.get(apiKeyId, agentId);
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
let agentRegistryInstance: AgentRegistryService | null = null;

/**
 * Initialize the agent registry service.
 * 
 * @param prisma - Prisma client instance
 */
export function initAgentRegistry(prisma: PrismaClient): void {
  agentRegistryInstance = new AgentRegistryService(prisma);
  logger.info('Agent registry service initialized');
}

/**
 * Get the agent registry service instance.
 * 
 * @returns AgentRegistryService instance
 * @throws Error if not initialized
 */
export function getAgentRegistry(): AgentRegistryService {
  if (!agentRegistryInstance) {
    throw new Error('Agent registry not initialized. Call initAgentRegistry() first.');
  }
  return agentRegistryInstance;
}