/**
 * @fileoverview Main Server Entry Point
 * @module server
 * 
 * This is the main entry point for the Consonant Control Plane server.
 * It initializes and coordinates all services:
 * - Fastify HTTP server (REST API)
 * - gRPC server (cluster streaming)
 * - Database (Prisma with multi-database support)
 * - Redis (rate limiting and caching)
 * - OpenTelemetry (distributed tracing)
 * - Inngest (event-driven workflows)
 * 
 * Startup sequence:
 * 1. Initialize OpenTelemetry SDK
 * 2. Load and validate configuration
 * 3. Connect to database
 * 4. Connect to Redis
 * 5. Initialize gRPC server
 * 6. Register Fastify plugins and routes
 * 7. Start HTTP and gRPC servers
 * 8. Set up graceful shutdown handlers
 */

import Fastify, { FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import compress from '@fastify/compress';
import closeWithGrace from 'close-with-grace';
import { serve } from 'inngest/fastify';

import { env, isDevelopment } from './config/env.js';
import { API_PATHS, TIMEOUTS } from './config/constants.js';
import { logger, flushLogger } from './utils/logger.js';
import { contextManager } from './utils/context.js';
import { generateUUID, generateTraceId } from './utils/crypto.js';
import { prismaManager } from './services/db/manager.js';
import { redisClient } from './services/redis/client.js';
import { inngest } from './services/inngest/client.js';
import { allFunctions } from './services/inngest/functions/registry.js';
import { startGrpcServer } from './services/grpc/server.js';
import { initWorkQueue } from './services/redis/queue.js';

let grpcServer: any;

/**
 * Create and configure Fastify instance.
 * 
 * Fastify is configured with:
 * - Structured logging (Pino)
 * - Request ID generation
 * - Trust proxy headers
 * - Production-grade timeouts
 */
function createFastifyServer(): FastifyInstance {
  return Fastify({
    logger,
    disableRequestLogging: false,
    trustProxy: true,
    requestIdHeader: 'x-request-id',
    requestIdLogLabel: 'reqId',

    // Request timeouts
    connectionTimeout: TIMEOUTS.REQUEST_MS,
    keepAliveTimeout: TIMEOUTS.REQUEST_MS,

    // Body size limits
    bodyLimit: 10 * 1024 * 1024, // 10MB

    // Generate unique request IDs
    genReqId: () => generateUUID(),
  });
}

/**
 * Initialize OpenTelemetry instrumentation.
 * 
 * This must run BEFORE any other imports to ensure all modules
 * are properly instrumented.
 * 
 * Note: In production, this would be in a separate file imported
 * at the very top of server.ts using --require or --import flag.
 */
async function initializeOpenTelemetry(): Promise<void> {
  if (!env.OTEL_ENABLED) {
    logger.info('OpenTelemetry disabled');
    return;
  }

  logger.info('Initializing OpenTelemetry...');

  const { initializeOpenTelemetry: initOtel } = await import('./services/opentelemetry/tracer.js');
  initOtel();

  logger.info('OpenTelemetry initialized');
}

/**
 * Initialize all backend services.
 * 
 * Services are initialized in dependency order:
 * 1. Database (required by everything)
 * 2. Redis (required by rate limiting)
 * 3. Other services
 */
async function initializeServices(app: FastifyInstance): Promise<void> {
  logger.info('Initializing services...');

  // 1. Initialize database
  await prismaManager.initialize(app.log);
  logger.info('✓ Database initialized');

  // 2. Initialize Redis
  await redisClient.connect();
  logger.info('✓ Redis connected');

  // 3. Initialize Work Queue
  const { initWorkQueue } = await import('./services/redis/queue.js');
  initWorkQueue(redisClient.getClient());
  logger.info('✓ Work queue initialized');

  // 4. Initialize Agent Registry
  const { initAgentRegistry } = await import('./services/agent-registry.js');
  initAgentRegistry(await prismaManager.getClient());
  logger.info('✓ Agent registry initialized');

  // 5. Initialize Cluster Selection
  const { initClusterSelection } = await import('./services/cluster-selection.js');
  initClusterSelection(await prismaManager.getClient());
  logger.info('✓ Cluster selection initialized');

  // 6. Initialize API Key Service
  const { initApiKeyService } = await import('./services/api-key.service.js');
  initApiKeyService(await prismaManager.getClient());
  logger.info('✓ API Key Service initialized');

  logger.info('✓ All services initialized');
}

/**
 * Register Fastify plugins.
 * 
 * Plugins are registered in a specific order to ensure
 * correct execution of hooks.
 */
async function registerPlugins(app: FastifyInstance): Promise<void> {
  logger.info('Registering Fastify plugins...');

  // Security headers
  await app.register(helmet, {
    contentSecurityPolicy: isDevelopment() ? false : undefined,
  });

  // CORS
  await app.register(cors, {
    origin: env.CORS_ORIGIN,
    credentials: true,
  });

  // Compression
  await app.register(compress, {
    global: true,
    encodings: ['gzip', 'deflate'],
  });

  logger.info('✓ Plugins registered');
}

/**
 * Register API routes.
 * 
 * Routes are organized by resource and mounted under /api/v1.
 */
async function registerRoutes(app: FastifyInstance): Promise<void> {
  logger.info('Registering routes...');

  // Health check endpoints (no prefix)
  app.get(API_PATHS.HEALTH, async () => {
    return {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      version: env.OTEL_SERVICE_VERSION,
    };
  });

  app.get(API_PATHS.HEALTH_DB, async () => {
    try {
      const client = await prismaManager.getClient();
      await client.$queryRaw`SELECT 1`;

      return {
        status: 'healthy',
        database: {
          connected: true,
          url: prismaManager.getCurrentDatabaseUrl(),
        },
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        database: {
          connected: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        timestamp: new Date().toISOString(),
      };
    }
  });

  // Inngest endpoint
  app.all(
    API_PATHS.INNGEST,
    serve({
      client: inngest,
      functions: allFunctions,
    })
  );

  // Register Prisma plugin for database access
  logger.info('Registering Prisma plugin...');
  const prismaPlugin = await import('./plugins/prisma.plugin.js');
  await app.register(prismaPlugin.default);

  // Register request timeline tracking plugin
  logger.info('Registering request timeline plugin...');
  const timelinePlugin = await import('./plugins/request-timeline.plugin.js');
  await app.register(timelinePlugin.default);

  // Register API routes
  const { registerRoutes } = await import('./routes/index.js');
  await registerRoutes(app);

  logger.info('✓ Routes registered');
}

/**
 * Set up request context injection.
 * 
 * This hook runs on every request and creates an execution context
 * with trace ID, request ID, etc. The context automatically
 * propagates through all async operations.
 */
function setupContextInjection(app: FastifyInstance): void {
  app.addHook('onRequest', (request, _reply, done) => {
    const traceId = (request.headers['x-trace-id'] as string) || generateTraceId();
    const requestId = request.id;

    // Create execution context
    contextManager.run({
      traceId,
      requestId,
      startTime: Date.now(),
    }, () => {
      // All subsequent hooks and handlers run within this context
      done();
    });
  });

  logger.info('✓ Context injection configured');
}

/**
 * Set up response logging.
 * 
 * Logs all requests with timing information and includes
 * context metadata (trace ID, request ID, etc.).
 */
function setupResponseLogging(app: FastifyInstance): void {
  app.addHook('onResponse', (request, reply, done) => {
    const duration = reply.elapsedTime;

    request.log.info({
      method: request.method,
      url: request.url,
      statusCode: reply.statusCode,
      durationMs: duration.toFixed(2),
      // Context is automatically injected by logger mixin
    }, 'Request completed');

    done();
  });

  logger.info('✓ Response logging configured');
}

/**
 * Set up global error handler.
 * 
 * Catches all unhandled errors and returns proper error responses.
 * In production, hides internal error details.
 */
function setupErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    request.log.error({
      err: error,
    }, 'Request error');

    const statusCode = (error as any).statusCode || 500;
    const errorResponse = {
      success: false,
      error: isDevelopment() ? (error as any).name : 'Internal Server Error',
      message: (error as any).message,
      ...(isDevelopment() && { stack: (error as any).stack }),
    };

    reply.status(statusCode).send(errorResponse);
  });

  logger.info('✓ Error handler configured');
}

/**
 * Set up graceful shutdown.
 * 
 * Handles SIGTERM and SIGINT signals to shut down cleanly.
 * 
 * Shutdown sequence:
 * 1. Stop accepting new requests (close servers)
 * 2. Wait for active requests to complete
 * 3. Close database connections
 * 4. Close Redis connections
 * 5. Flush logs
 * 6. Exit process
 */
function setupGracefulShutdown(app: FastifyInstance): void {
  closeWithGrace(
    { delay: TIMEOUTS.SHUTDOWN_MS },
    async ({ signal, err }) => {
      if (err) {
        logger.error({ err }, 'Error triggered shutdown');
      }

      logger.info(`🛑 Received ${signal}, shutting down gracefully...`);

      // 1. Close Fastify server (stop accepting requests)
      logger.info('Closing Fastify server...');
      await app.close();
      logger.info('✓ Fastify server closed');

      // 2. Close gRPC server
      if (grpcServer) {
        logger.info('Closing gRPC server...');
        await grpcServer.stop();
        logger.info('✓ gRPC server closed');
      }

      // 2. Disconnect Redis
      logger.info('Disconnecting Redis...');
      await redisClient.disconnect();
      logger.info('✓ Redis disconnected');

      // 3. Disconnect database (waits for active requests)
      logger.info('Disconnecting database...');
      await prismaManager.disconnect();
      logger.info('✓ Database disconnected');

      // 4. Flush logs
      logger.info('Flushing logs...');
      await flushLogger();
      logger.info('✓ Logs flushed');

      logger.info('🎉 Shutdown complete');
    }
  );

  logger.info('✓ Graceful shutdown configured');
}

/**
 * Start the server.
 * 
 * This is the main application entry point that orchestrates
 * the entire startup sequence.
 */
async function start(): Promise<void> {
  try {
    logger.info('🚀 Starting Consonant Control Plane...');


    // 1. Initialize OpenTelemetry (must be first)
    await initializeOpenTelemetry();

    // 2. Create Fastify server
    const app = createFastifyServer();
    logger.info('✓ Fastify server created');

    // 3. Initialize services
    await initializeServices(app);
    initWorkQueue(redisClient.getClient());


    grpcServer = await startGrpcServer(env.GRPC_PORT);

    logger.info(`✓ gRPC server listening on ${env.GRPC_HOST}:${env.GRPC_PORT}`);

    // 4. Register plugins
    await registerPlugins(app);

    // 5. Set up request hooks
    setupContextInjection(app);
    setupResponseLogging(app);
    setupErrorHandler(app);

    // 6. Register routes
    await registerRoutes(app);

    // 7. Set up graceful shutdown
    setupGracefulShutdown(app);

    // 8. Wait for server to be ready
    await app.ready();
    logger.info('✓ Fastify server ready');

    // 9. Start HTTP server
    await app.listen({
      port: env.PORT,
      host: env.HOST,
    });

    logger.info(`✓ HTTP server listening on http://${env.HOST}:${env.PORT}`);
    logger.info(`✓ Health check: http://${env.HOST}:${env.PORT}${API_PATHS.HEALTH}`);
    logger.info(`✓ Inngest: http://${env.HOST}:${env.PORT}${API_PATHS.INNGEST}`);

    logger.info('🎉 Server started successfully');
  } catch (error) {
    logger.fatal({ err: error }, 'Failed to start server');
    process.exit(1);
  }
}

// Start the server
start();