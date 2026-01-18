/**
 * @fileoverview Prisma Fastify Plugin
 * @module plugins/prisma
 * 
 * Fastify plugin that injects the Prisma client into every request.
 * This provides type-safe database access throughout all route handlers.
 * 
 * LIFECYCLE:
 * 1. Plugin registered during server startup
 * 2. Decorates request object with prisma property
 * 3. Every request gets access to the same Prisma client instance
 * 4. Active request tracking for graceful shutdown
 * 
 * BENEFITS:
 * - Type-safe database access in all routes
 * - Single client instance (no connection pool exhaustion)
 * - Automatic request tracking for graceful shutdown
 * - Clean dependency injection pattern
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import { prismaManager } from '@/services/db/manager.js';

/**
 * Prisma plugin that injects the client into every request.
 * 
 * This plugin:
 * 1. Gets the Prisma client from the manager
 * 2. Decorates the request object with the client
 * 3. Tracks active requests for graceful shutdown
 * 
 * @param app - Fastify instance
 */
async function prismaPlugin(app: FastifyInstance): Promise<void> {
  // Get the Prisma client from manager
  const client = await prismaManager.getClient();

  // Decorate requests with Prisma client
  app.decorateRequest('prisma', { getter: () => client });

  // Track active requests for graceful shutdown
  app.addHook('onRequest', async (_request: FastifyRequest, _reply: FastifyReply) => {
    prismaManager.incrementActiveRequests();
  });

  app.addHook('onResponse', async (_request: FastifyRequest, _reply: FastifyReply) => {
    prismaManager.decrementActiveRequests();
  });

  // Log successful plugin registration
  app.log.info('✓ Prisma plugin registered');
}

/**
 * Export as Fastify plugin with fastify-plugin wrapper.
 * This ensures the plugin's decorators are available globally.
 */
export default fp(prismaPlugin, {
  name: 'prisma',
  fastify: '4.x',
});