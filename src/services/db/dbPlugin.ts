/**
 * @fileoverview Database fastify plugin
 * @module services/db/dbPlugin
 * 
 */
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import { PrismaClient } from '@prisma/client';
import { detectProvider } from './config.js';
import { prismaManager } from './manager.js';


/**
 * Extend Fastify types to include prisma clients on request object.
 * 
 * This allows you to access both clients via:
 * - `request.prisma` - Operational database
 * - `request.telemetry` - Telemetry database (TimescaleDB or shared)
 */
declare module 'fastify' {
  interface FastifyRequest {
    /** Prisma client instance for operational database */
    prisma: PrismaClient;
    
    /** Prisma client instance for telemetry database (TimescaleDB or shared) */
    telemetry: PrismaClient;
  }
}

/**
 * Fastify plugin for database integration.
 * 
 * **Features:**
 * - ✓ Ensures database is initialized before handling requests
 * - ✓ Tracks active requests for graceful shutdown
 * - ✓ Attaches both Prisma clients to each request
 * - ✓ Provides health check endpoint for both databases
 * - ✓ Returns 503 if database is unavailable
 * 
 * **Lifecycle hooks:**
 * 1. `preHandler` - Check database is ready, attach clients to request
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
 *   // Access operational DB via request.prisma
 *   const users = await request.prisma.user.findMany();
 *   return users;
 * });
 * 
 * // For telemetry data:
 * app.get('/traces', async (request, reply) => {
 *   // Access telemetry DB via request.telemetry
 *   const traces = await request.telemetry.trace.findMany();
 *   return traces;
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
  fastify.addHook('preHandler', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      // Check if database is initialized
      if (!prismaManager.isReady()) {
        logger.warn('[DB Plugin] Database not ready, returning 503');
        
        return reply.status(503).send({
          error: 'Service Unavailable',
          message: 'Database is not ready. Server may still be initializing.',
          timestamp: new Date().toISOString(),
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ error }, '[DB Plugin] ❌ Database readiness check failed');

      return reply.status(503).send({
        error: 'Service Unavailable',
        message: 'Database is not ready',
        details: errorMessage,
        timestamp: new Date().toISOString(),
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
   * Hook 4: Attach Prisma clients to request
   * 
   * Makes both Prisma clients available:
   * - `request.prisma` - Operational database
   * - `request.telemetry` - Telemetry database (TimescaleDB or shared)
   * 
   * This provides clean, type-safe access to both databases.
   */
  fastify.addHook('preHandler', async (request: FastifyRequest) => {
    try {
      // Attach operational client
      const operationalClient = await prismaManager.getClient();
      request.prisma = operationalClient;

      // Attach telemetry client (may be same as operational if not using TimescaleDB)
      const telemetryClient = await prismaManager.getTelemetryClient();
      request.telemetry = telemetryClient;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ error }, '[DB Plugin] ❌ Failed to attach Prisma clients');
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
   * - `database.operational` - Operational database status
   * - `database.telemetry` - Telemetry database status
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
   *     "operational": {
   *       "connected": true,
   *       "provider": "postgresql",
   *       "url": "postgresql://****@localhost:5432/consonant"
   *     },
   *     "telemetry": {
   *       "connected": true,
   *       "provider": "postgresql",
   *       "url": "postgresql://****@localhost:5433/consonant_telemetry",
   *       "separate": true
   *     },
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
            operational: {
              connected: false,
              message: 'Database not initialized',
            },
            telemetry: {
              connected: false,
              message: 'Database not initialized',
            },
          },
          timestamp: new Date().toISOString(),
        });
      }

      // Test operational database connection
      const operationalClient = await prismaManager.getClient();
      await operationalClient.$queryRaw`SELECT 1`;
      
      const operationalUrl = prismaManager.getCurrentDatabaseUrl();
      const operationalProvider = operationalUrl ? detectProvider(logger).provider : 'unknown';

      // Test telemetry database connection
      const telemetryClient = await prismaManager.getTelemetryClient();
      const telemetryUrl = prismaManager.getCurrentTimescaleUrl();
      const hasSeparateTelemetry = prismaManager.hasSeparateTelemetryDB();
      
      let telemetryHealthy = false;
      try {
        await telemetryClient.$queryRaw`SELECT 1`;
        telemetryHealthy = true;
      } catch (error) {
        logger.warn({ error }, '[DB Plugin] Telemetry database health check failed');
      }

      // Mask passwords in URLs for security
      const maskUrl = (url: string | null) => 
        url ? url.replace(/:[^:@]*@/, ':****@') : 'not configured';

      // Return healthy status
      return {
        status: telemetryHealthy ? 'healthy' : 'partial',
        database: {
          operational: {
            connected: true,
            provider: operationalProvider,
            url: maskUrl(operationalUrl),
          },
          telemetry: {
            connected: telemetryHealthy,
            provider: hasSeparateTelemetry ? 'timescaledb' : operationalProvider,
            url: hasSeparateTelemetry ? maskUrl(telemetryUrl) : 'shared',
            separate: hasSeparateTelemetry,
          },
          activeRequests: prismaManager.getActiveRequestCount(),
        },
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ error }, '[DB Plugin] ❌ Health check failed');

      return reply.status(503).send({
        status: 'unhealthy',
        database: {
          operational: {
            connected: false,
            error: errorMessage,
          },
          telemetry: {
            connected: false,
            error: errorMessage,
          },
        },
        timestamp: new Date().toISOString(),
      });
    }
  });

  logger.info('[DB Plugin] ✓ Database plugin registered successfully');
  
  // Log configuration
  if (prismaManager.hasSeparateTelemetryDB()) {
    logger.info('[DB Plugin] ℹ Using separate TimescaleDB for telemetry');
  } else {
    logger.info('[DB Plugin] ℹ Using shared database for operational + telemetry');
  }
};

/**
 * Export wrapped plugin using fastify-plugin.
 * 
 * This ensures the plugin decorators (like request.prisma and request.telemetry) 
 * are available across the entire Fastify application, not just in the plugin's scope.
 */
export default fp(dbPlugin, {
  name: 'database-plugin',
  fastify: '5.6.2',
});