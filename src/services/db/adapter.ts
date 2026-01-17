/**
 * @fileoverview Database Adapter
 * @module services/db/adapter
 * 
 * Creates the appropriate database adapter based on DATABASE_URL.
 * 
 * HOW IT WORKS:
 * - Reads DATABASE_URL from environment
 * - Detects provider (postgresql, sqlite)
 * - Creates and returns the matching Prisma adapter
 * 
 * IMPORTANT: This enables multi-database support at runtime.
 * The schema.prisma file may have a static provider field, but Prisma
 * uses the adapter to determine actual database behavior.
 * 
 * BENEFITS:
 * - Works with static artifacts
 * - Compatible with bundled applications
 * - Provider detected from environment at runtime
 */

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaLibSql } from '@prisma/adapter-libsql';
import pg from 'pg';
import { detectProvider } from './config.js';
import type { DbConfig, DatabaseAdapter, AppLogger } from './types.js';

/**
 * Creates the appropriate database adapter based on DATABASE_URL.
 * 
 * @param logger - Logger instance for diagnostic messages
 * @param databaseUrl - Optional database URL override (defaults to process.env.DATABASE_URL)
 * @returns Prisma adapter instance for the detected provider
 * @throws {Error} If provider is unsupported or adapter creation fails
 * 
 * @example
 * const adapter = createAdapter(logger);
 * const prisma = new PrismaClient({ adapter });
 */
export function createAdapter(logger: AppLogger, databaseUrl?: string): DatabaseAdapter {
  // Temporarily override DATABASE_URL if custom URL provided
  const originalUrl = process.env.DATABASE_URL;

  try {
    if (databaseUrl) {
      process.env.DATABASE_URL = databaseUrl;
    }

    // Detect provider from URL
    const dbConfig = detectProvider(logger);

    // Create adapter for detected provider
    const adapter = createAdapterFromConfig(dbConfig, logger);

    logger.info(
      `[DB Adapter] ✓ Created ${dbConfig.provider} adapter (detected from DATABASE_URL)`
    );

    return adapter;
  } finally {
    // Restore original URL
    if (databaseUrl && originalUrl !== undefined) {
      process.env.DATABASE_URL = originalUrl;
    } else if (databaseUrl) {
      delete process.env.DATABASE_URL;
    }
  }
}

/**
 * Creates a Prisma adapter from a parsed DbConfig object.
 * 
 * ADAPTER SELECTION:
 * - PostgreSQL → PrismaPg (uses pg Pool)
 * - SQLite → PrismaLibSQL (uses libsql client)
 * 
 * @param config - Parsed database configuration
 * @param logger - Logger instance for diagnostic messages
 * @returns Prisma adapter instance
 * @throws {Error} If provider is unsupported or required fields are missing
 */
function createAdapterFromConfig(config: DbConfig, logger: AppLogger): DatabaseAdapter {
  switch (config.provider) {
    case 'postgresql':
      return createPostgreSQLAdapter(config, logger);

    case 'sqlite':
      return createSQLiteAdapter(config, logger);

    default:
      throw new Error(`[DB Adapter] Unsupported database provider: ${config.provider}`);
  }
}

/**
 * Creates PostgreSQL adapter using pg Pool.
 * 
 * Configures connection pool with production-grade settings:
 * - Max 20 connections
 * - 30 second idle timeout
 * - 10 second connection timeout
 * 
 * @param config - Database configuration with PostgreSQL details
 * @param logger - Logger instance
 * @returns PrismaPg adapter instance
 */
function createPostgreSQLAdapter(config: DbConfig, logger: AppLogger): DatabaseAdapter {
  logger.info('[DB Adapter] Creating PostgreSQL adapter with managed pool...');

  const pool = new pg.Pool({
    connectionString: config.connectionString,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });

  return new PrismaPg(pool);
}

/**
 * Creates SQLite adapter using libsql client.
 * 
 * SUPPORTS:
 * - Local file databases: file:./database.db
 * - In-memory databases: file::memory:
 * - Turso remote databases: libsql://...
 * 
 * @param config - Database configuration with SQLite details
 * @param logger - Logger instance
 * @returns PrismaLibSQL adapter instance
 */
function createSQLiteAdapter(config: DbConfig, logger: AppLogger): DatabaseAdapter {
  logger.info('[DB Adapter] Creating SQLite adapter...');

  return new PrismaLibSql({
    url: config.connectionString,
  });
}

/**
 * Validates that an adapter is properly initialized.
 * 
 * @param adapter - Adapter instance to validate
 * @returns True if adapter is valid
 */
export function isValidAdapter(adapter: DatabaseAdapter): boolean {
  return adapter !== null && adapter !== undefined;
}