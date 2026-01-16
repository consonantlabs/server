/**
 * Agent management routes
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { parseYAML } from '../utils/yaml-parser.js';
import { validateTerraAgent } from '../schemas/agent.schema.js';
import { validateTerraSemantics } from '../utils/validators.js';
import { sendEvent } from '../services/inngest/client.js';
import { logger } from '../utils/logger.js';
import type { TerraAgentManifest } from '../schemas/agent.schema.js';

export async function agentRoutes(app: FastifyInstance) {
  /**
   * POST /api/v1/agents
   * Create a new agent from Terra YAML
   */
  app.post('/agents', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = request.body as any;
      const yamlContent = body.yaml || body.manifest;
      const clusterId = body.clusterId;

      if (!yamlContent) {
        return reply.code(400).send({
          success: false,
          error: 'Missing yaml or manifest in request body',
        });
      }

      if (!clusterId) {
        return reply.code(400).send({
          success: false,
          error: 'Missing clusterId in request body',
        });
      }

      // Parse YAML
      const parsed = parseYAML<TerraAgentManifest>(yamlContent);

      // Structural validation (Zod)
      const structuralResult = validateTerraAgent(parsed);
      if (!structuralResult.valid) {
        return reply.code(400).send({
          success: false,
          error: 'Structural validation failed',
          errors: structuralResult.errors,
        });
      }

      // Semantic validation
      const semanticResult = await validateTerraSemantics(structuralResult.data);
      if (!semanticResult.valid) {
        return reply.code(400).send({
          success: false,
          error: 'Semantic validation failed',
          errors: semanticResult.errors,
          warnings: semanticResult.warnings,
        });
      }

      // Create agent in database
      const agent = await request.prisma.agent.create({
        data: {
          name: structuralResult.data.metadata.name,
          clusterId,
          status: 'PENDING',
          terraDefinition: structuralResult.data as any,
          image: structuralResult.data.spec.runtime.image,
          replicas: structuralResult.data.spec.deployment.scaling.replicas,
          cpuRequest: structuralResult.data.spec.deployment.resources.cpu,
          cpuLimit: structuralResult.data.spec.limits.resources.maxCpu,
          memoryRequest: structuralResult.data.spec.deployment.resources.memory,
          memoryLimit: structuralResult.data.spec.limits.resources.maxMemory,
          description: structuralResult.data.spec.description,
        },
      });

      // Emit event to Inngest
      await sendEvent({
        name: 'terra.agent.created',
        data: {
          agentId: agent.id,
          agentName: agent.name,
          clusterId,
          requestId: request.id,
          createdAt: agent.createdAt.toISOString(),
        },
      });

      logger.info({
        agentId: agent.id,
        agentName: agent.name,
      },'Agent created successfully');

      return reply.code(201).send({
        success: true,
        data: {
          id: agent.id,
          name: agent.name,
          status: agent.status,
          warnings: semanticResult.warnings,
        },
      });
    } catch (error) {
      logger.error({ error },'Failed to create agent');
      return reply.code(500).send({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  /**
   * GET /api/v1/agents
   * List all agents
   */
  app.get('/agents', async (request, reply) => {
    const agents = await request.prisma.agent.findMany({
      select: {
        id: true,
        name: true,
        status: true,
        image: true,
        replicas: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    return { success: true, data: agents };
  });

  /**
   * GET /api/v1/agents/:id
   * Get agent by ID
   */
  app.get<{ Params: { id: string } }>('/agents/:id', async (request, reply) => {
    const agent = await request.prisma.agent.findUnique({
      where: { id: request.params.id },
    });

    if (!agent) {
      return reply.code(404).send({
        success: false,
        error: 'Agent not found',
      });
    }

    return { success: true, data: agent };
  });

  /**
   * DELETE /api/v1/agents/:id
   * Delete agent
   */
  app.delete<{ Params: { id: string } }>('/agents/:id', async (request, reply) => {
    try {
      await request.prisma.agent.delete({
        where: { id: request.params.id },
      });

      return { success: true };
    } catch {
      return reply.code(404).send({
        success: false,
        error: 'Agent not found',
      });
    }
  });
}