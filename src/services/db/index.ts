// src/db/index.ts

/**
 * Database Module - Multi-Database Support for Prisma
 * 
 * This module provides a production-ready database layer with:
 * - ✓ Multi-database support (PostgreSQL, SQLite)
 * - ✓ Runtime database detection from DATABASE_URL
 * - ✓ Connection retry with exponential backoff
 * - ✓ Graceful shutdown with active request tracking
 * - ✓ Type-safe Prisma client access
 * - ✓ Fastify integration via plugin
 * - ✓ Health check endpoints
 * - ✓ CLI command helpers
 * 
 * **Quick Start:**
 * 
 * ```typescript
 * // 1. In server.ts:
 * import { prismaManager, dbPlugin } from './db/index.js';
 * 
 * // Initialize database
 * await prismaManager.initialize(app.log);
 * 
 * // Register plugin
 * await app.register(dbPlugin);
 * 
 * // 2. In routes:
 * import { prisma } from './db/index.js';
 * 
 * app.get('/users', async () => {
 *   return await prisma.user.findMany();
 * });
 * 
 * // 3. In shutdown:
 * await prismaManager.disconnect();
 * ```
 */

// ============================================================================
// Core Manager & Client
// ============================================================================

/**
 * Prisma Manager - Singleton for database lifecycle management
 * 
 * @see {@link manager.ts} for implementation
 * 
 * **Methods:**
 * - `initialize(logger)` - Initialize database connection
 * - `getClient()` - Get Prisma client instance
 * - `disconnect()` - Gracefully disconnect
 * - `isReady()` - Check if initialized
 * - `getActiveRequestCount()` - Get active request count
 */
export { prismaManager } from './manager.js';

/**
 * Prisma Client - Clean proxy for database operations
 * 
 * @see {@link client.ts} for implementation
 * 
 * **Usage:**
 * ```typescript
 * import { prisma } from './db/index.js';
 * 
 * const users = await prisma.user.findMany();
 * const post = await prisma.post.create({ data: {...} });
 * ```
 */

/**
 * Export Prisma Client type for typing
 */

// ============================================================================
// Fastify Plugin
// ============================================================================

/**
 * Database Fastify Plugin
 * 
 * @see {@link dbPlugin.ts} for implementation
 * 
 * **What it does:**
 * - Ensures database is ready before handling requests
 * - Tracks active requests for graceful shutdown
 * - Attaches Prisma client to `request.prisma`
 * - Adds `GET /health/db` endpoint
 * 
 * **Usage:**
 * ```typescript
 * import dbPlugin from './db/index.js';
 * 
 * await app.register(dbPlugin);
 * 
 * // In routes:
 * app.get('/users', async (request) => {
 *   return await request.prisma.user.findMany();
 * });
 * ```
 */
export { default as dbPlugin } from './dbPlugin.js';

// ============================================================================
// Configuration
// ============================================================================

/**
 * Database configuration utilities
 * 
 * @see {@link config.ts} for implementation
 * 
 * **Functions:**
 * - `detectProvider()` - Detect database from DATABASE_URL
 * - `validateDbConfig()` - Validate configuration
 * - `getCurrentDatabaseUrl()` - Get current URL
 * - `isProduction()` - Check if production environment
 * - `isTest()` - Check if test environment
 */
export {
  detectProvider,
  validateDbConfig,
  getCurrentDatabaseUrl,
  isProduction,
  isTest,
} from './config.js';

// ============================================================================
// Adapter
// ============================================================================

/**
 * Database adapter creation
 * 
 * @see {@link adapter.ts} for implementation
 * 
 * **Functions:**
 * - `createAdapter()` - Create adapter for detected database
 * - `isValidAdapter()` - Validate adapter
 */
export { createAdapter, isValidAdapter } from './adapter.js';

// ============================================================================
// Connection
// ============================================================================

/**
 * Connection management utilities
 * 
 * @see {@link connection.ts} for implementation
 * 
 * **Functions:**
 * - `connectWithRetry()` - Connect with exponential backoff
 * - `disconnect()` - Gracefully disconnect
 * - `isConnected()` - Check connection status
 */
export { connectWithRetry, disconnect, isConnected } from './connection.js';

// ============================================================================
// CLI Commands
// ============================================================================

/**
 * Prisma CLI command helpers
 * 
 * @see {@link commands.ts} for implementation
 * 
 * **Functions:**
 * - `generatePrismaClient()` - Generate Prisma Client
 * - `runMigrations()` - Run migrations (development)
 * - `deployMigrations()` - Deploy migrations (production)
 * - `resetDatabase()` - Reset database (⚠ DELETES ALL DATA)
 * - `pushSchema()` - Push schema without migrations
 * - `validateSchema()` - Validate schema.prisma
 * - `pullSchema()` - Pull schema from database
 * - `openStudio()` - Open Prisma Studio
 * 
 * **Usage:**
 * ```typescript
 * import { deployMigrations } from './db/index.js';
 * 
 * const result = await deployMigrations(logger);
 * if (!result.success) {
 *   throw new Error('Migration failed');
 * }
 * ```
 */
export {
  runPrismaCommand,
  generatePrismaClient,
  runMigrations,
  deployMigrations,
  resetDatabase,
  pushSchema,
  validateSchema,
  pullSchema,
  openStudio,
} from './commands.js';

// ============================================================================
// Types
// ============================================================================

/**
 * TypeScript types for database module
 * 
 * @see {@link types.ts} for definitions
 */
export type {
  DbProvider,
  DbConfig,
  ConnectionResult,
  CommandResult,
  AppLogger,
  DatabaseAdapter,
} from './types.js';

// ============================================================================
// Re-export Prisma Client type
// ============================================================================

/**
 * Re-export Prisma Client from @prisma/client for convenience
 */
export { PrismaClient } from '@prisma/client';