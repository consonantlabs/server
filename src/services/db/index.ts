/**
 * @fileoverview Database Module Exports
 * @module services/db
 * 
 * Database Module - Multi-Database Support for Prisma
 * 
 * This module provides a production-ready database layer with:
 * - Multi-database support (PostgreSQL, SQLite)
 * - Runtime database detection from DATABASE_URL
 * - Connection retry with exponential backoff
 * - Graceful shutdown with active request tracking
 * - Type-safe Prisma client access
 * 
 * QUICK START:
 * 
 * // 1. In server.ts:
 * import { prismaManager } from '@/services/db';
 * 
 * // Initialize database
 * await prismaManager.initialize(app.log);
 * 
 * // 2. In routes:
 * const client = await prismaManager.getClient();
 * const users = await client.user.findMany();
 * 
 * // 3. In shutdown:
 * await prismaManager.disconnect();
 */

// ============================================================================
// Core Manager & Client
// ============================================================================

/**
 * Prisma Manager - Singleton for database lifecycle management.
 * 
 * METHODS:
 * - initialize(logger) - Initialize database connection
 * - getClient() - Get Prisma client instance
 * - disconnect() - Gracefully disconnect
 * - isReady() - Check if initialized
 * - getActiveRequestCount() - Get active request count
 */
export { prismaManager } from './manager.js';

/**
 * Export Prisma Client type for typing.
 */
export { PrismaClient } from '@prisma/client';

// ============================================================================
// Configuration
// ============================================================================

/**
 * Database configuration utilities.
 * 
 * FUNCTIONS:
 * - detectProvider() - Detect database from DATABASE_URL
 * - validateDbConfig() - Validate configuration
 * - getCurrentDatabaseUrl() - Get current URL
 * - isProduction() - Check if production environment
 * - isTest() - Check if test environment
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
 * Database adapter creation.
 * 
 * FUNCTIONS:
 * - createAdapter() - Create adapter for detected database
 * - isValidAdapter() - Validate adapter
 */
export { createAdapter, isValidAdapter } from './adapter.js';

// ============================================================================
// Connection
// ============================================================================

/**
 * Connection management utilities.
 * 
 * FUNCTIONS:
 * - connectWithRetry() - Connect with exponential backoff
 * - disconnect() - Gracefully disconnect
 * - isConnected() - Check connection status
 */
export { connectWithRetry, disconnect, isConnected } from './connection.js';

// ============================================================================
// Types
// ============================================================================

/**
 * TypeScript types for database module.
 */
export type {
  DbProvider,
  DbConfig,
  ConnectionResult,
  AppLogger,
  DatabaseAdapter,
} from './types.js';