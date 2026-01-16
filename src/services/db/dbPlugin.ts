// src/db/dbPlugin.ts
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import { PrismaClient } from '@prisma/client';
import { detectProvider } from './config.js';
import { prismaManager } from './manager.js';

/**
 * Extend Fastify types to include prisma on request object.
 * 
 * This allows you to access Prisma client via `request.prisma` in routes.
 */
declare module 'fastify' {
  interface FastifyRequest {
    /** Prisma client instance attached to this request */
    prisma: PrismaClient;
  }
}

/**
 * Fastify plugin for database integration.
 * 
 * **Features:**
 * - ✓ Ensures database is initialized before handling requests
 * - ✓ Tracks active requests for graceful shutdown
 * - ✓ Attaches Prisma client to each request
 * - ✓ Provides health check endpoint
 * - ✓ Returns 503 if database is unavailable
 * 
 * **Lifecycle hooks:**
 * 1. `preHandler` - Check database is ready, attach client to request
 * 2. `onRequest` - Increment active request counter
 * 3. `onResponse` - Decrement active request counter
 * 
 * **Routes added:**
 * - `GET /health/db` - Database health check endpoint
 * 
 * @example
 * ```typescript
 * // In server.ts:
 * import dbPlugin from './db/dbPlugin.js';
 * 
 * await app.register(dbPlugin);
 * 
 * // In routes:
 * app.get('/users', async (request, reply) => {
 *   // Access Prisma via request.prisma
 *   const users = await request.prisma.user.findMany();
 *   return users;
 * });
 * ```
 */
const dbPlugin: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  const logger = fastify.log;

  /**
   * Hook 1: Pre-handler - Ensure database is ready
   * 
   * Runs before every request handler to ensure database is initialized.
   * Returns 503 Service Unavailable if database is not ready.
   */
  fastify.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      // Check if database is initialized
      if (!prismaManager.isReady()) {
        logger.warn('[DB Plugin] Database not ready, initializing...');
        await prismaManager.initialize(logger);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error({error},'[DB Plugin] ❌ Database initialization failed');

      return reply.status(503).send({
        error: 'Service Unavailable',
        message: 'Database is not ready',
        details: errorMessage,
      });
    }
  });

  /**
   * Hook 2: On request - Track active requests
   * 
   * Increments the active request counter for graceful shutdown.
   * This allows the manager to wait for requests to complete before disconnecting.
   */
  fastify.addHook('onRequest', async () => {
    prismaManager.incrementActiveRequests();
  });

  /**
   * Hook 3: On response - Release active requests
   * 
   * Decrements the active request counter when the request completes.
   */
  fastify.addHook('onResponse', async () => {
    prismaManager.decrementActiveRequests();
  });

  /**
   * Hook 4: Attach Prisma client to request
   * 
   * Makes Prisma client available as `request.prisma` in all routes.
   * This provides clean, type-safe access to the database.
   */
  fastify.addHook('preHandler', async (request: FastifyRequest) => {
    try {
      const client = await prismaManager.getClient();
      request.prisma = client;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error({error}, '[DB Plugin] ❌ Failed to attach Prisma client');
      throw new Error(`Database connection failed: ${errorMessage}`);
    }
  });

  /**
   * Database health check endpoint.
   * 
   * **Response:**
   * - 200 OK: Database is healthy and responsive
   * - 503 Service Unavailable: Database is not initialized or not responding
   * 
   * **Response body includes:**
   * - `status` - 'healthy' | 'unhealthy' | 'unavailable'
   * - `database.connected` - Connection status
   * - `database.provider` - Database type (postgresql, mysql, sqlite)
   * - `database.activeRequests` - Current active request count
   * - `timestamp` - ISO timestamp
   * 
   * @route GET /health/db
   * 
   * @example
   * ```bash
   * curl http://localhost:3000/health/db
   * ```
   * 
   * ```json
   * {
   *   "status": "healthy",
   *   "database": {
   *     "connected": true,
   *     "provider": "postgresql",
   *     "activeRequests": 5
   *   },
   *   "timestamp": "2025-01-01T00:00:00.000Z"
   * }
   * ```
   */
  fastify.get('/health/db', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      // Check if manager is initialized
      const isReady = prismaManager.isReady();
      if (!isReady) {
        return reply.status(503).send({
          status: 'unavailable',
          database: {
            connected: false,
            message: 'Database not initialized',
          },
          timestamp: new Date().toISOString(),
        });
      }

      // Get client and test connection
      const client = await prismaManager.getClient();
      await client.$queryRaw`SELECT 1`;

      // Get database provider info
      const currentUrl = prismaManager.getCurrentDatabaseUrl();
      const provider = currentUrl ? detectProvider(logger).provider : 'unknown';

      // Return healthy status
      return {
        status: 'healthy',
        database: {
          connected: true,
          provider,
          activeRequests: prismaManager.getActiveRequestCount(),
        },
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error({error}, '[DB Plugin] ❌ Health check failed');

      return reply.status(503).send({
        status: 'unhealthy',
        database: {
          connected: false,
          error: errorMessage,
        },
        timestamp: new Date().toISOString(),
      });
    }
  });

  logger.info('[DB Plugin] ✓ Database plugin registered successfully');
};

/**
 * Export wrapped plugin using fastify-plugin.
 * 
 * This ensures the plugin decorators (like request.prisma) are available
 * across the entire Fastify application, not just in the plugin's scope.
 */
export default fp(dbPlugin, {
  name: 'database-plugin',
  fastify: '5.6.2',
});