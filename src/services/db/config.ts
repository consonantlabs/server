/**
 * @fileoverview Database Configuration
 * @module services/db/config
 * 
 * Detects database provider from DATABASE_URL and extracts connection details.
 * 
 * ENVIRONMENT-SPECIFIC BEHAVIOR:
 * - Production: DATABASE_URL is REQUIRED, throws if missing
 * - Test: Defaults to SQLite (file:./test.db) if not set
 * - Development: Defaults to SQLite (file:./local.db) if not set
 * 
 * SUPPORTED URL FORMATS:
 * - PostgreSQL: postgresql://user:pass@host:port/database
 * - SQLite: file:./path/to/database.db
 */

import { URL } from 'url';
import type { DbConfig, DbProvider, AppLogger } from './types.js';

/**
 * Detects database provider from DATABASE_URL and extracts connection details.
 * 
 * @param logger - Optional logger for warnings and info messages
 * @returns Parsed database configuration
 * @throws {Error} If DATABASE_URL is invalid or missing in production
 * 
 * @example
 * const config = detectProvider(logger);
 * console.log(config.provider); // 'postgresql'
 * console.log(config.connectionString); // Full URL
 */
export function detectProvider(logger?: AppLogger): DbConfig {
  const env = process.env.NODE_ENV || 'development';
  let dbUrl: string | undefined = process.env.DATABASE_URL;

  // Handle missing DATABASE_URL based on environment
  if (!dbUrl || dbUrl.trim() === '') {
    return handleMissingDatabaseUrl(env, logger);
  }

  // Parse and validate the DATABASE_URL
  try {
    return parseDatabaseUrl(dbUrl);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    throw new Error(
      `[DB Config] ❌ Invalid DATABASE_URL format: ${dbUrl}. Error: ${errorMessage}`
    );
  }
}

/**
 * Handles missing DATABASE_URL with environment-specific defaults.
 * 
 * @param env - Current NODE_ENV value
 * @param logger - Optional logger for warnings
 * @returns Default database configuration
 * @throws {Error} If in production environment
 */
function handleMissingDatabaseUrl(env: string, logger?: AppLogger): DbConfig {
  if (env === 'production') {
    throw new Error(
      '[DB Config] ❌ PRODUCTION ERROR: DATABASE_URL environment variable is required.'
    );
  }

  if (env === 'test') {
    const testUrl = 'file:./test.db';
    logger?.warn(
      `[DB Config] Running in 'test' environment. Defaulting to SQLite: ${testUrl}`
    );
    return {
      provider: 'sqlite',
      connectionString: testUrl,
    };
  }

  // Development default
  const defaultUrl = 'file:./local.db';
  logger?.warn(
    `[DB Config] DATABASE_URL not set. Defaulting to SQLite: ${defaultUrl}`
  );
  return {
    provider: 'sqlite',
    connectionString: defaultUrl,
  };
}

/**
 * Parses a DATABASE_URL and extracts connection information.
 * 
 * @param dbUrl - Full database URL to parse
 * @returns Parsed database configuration
 * @throws {Error} If URL format is invalid or protocol unsupported
 */
function parseDatabaseUrl(dbUrl: string): DbConfig {
  // Handle SQLite file:// URLs
  if (dbUrl.startsWith('file:')) {
    return {
      provider: 'sqlite',
      connectionString: dbUrl,
    };
  }

  // Parse standard database URLs
  const parsedUrl = new URL(dbUrl);
  const protocol = parsedUrl.protocol.replace(':', '').toLowerCase();

  // Detect provider from protocol
  const provider = mapProtocolToProvider(protocol);

  // Extract connection details for PostgreSQL
  if (provider === 'postgresql') {
    return {
      provider,
      connectionString: dbUrl,
      host: parsedUrl.hostname,
      port: parsedUrl.port ? parseInt(parsedUrl.port, 10) : undefined,
      user: parsedUrl.username || undefined,
      password: parsedUrl.password || undefined,
      database: parsedUrl.pathname.slice(1) || undefined, // Remove leading '/'
    };
  }

  // SQLite (non-file protocol)
  return {
    provider,
    connectionString: dbUrl,
  };
}

/**
 * Maps URL protocol to database provider.
 * 
 * @param protocol - URL protocol (without colon)
 * @returns Database provider type
 * @throws {Error} If protocol is unsupported
 */
function mapProtocolToProvider(protocol: string): DbProvider {
  switch (protocol) {
    case 'postgresql':
    case 'postgres':
      return 'postgresql';
    case 'sqlite':
      return 'sqlite';
    default:
      throw new Error(
        `Unsupported database protocol: "${protocol}". Supported: postgresql, sqlite.`
      );
  }
}

/**
 * Validates database configuration for the current environment.
 * Ensures required fields are present based on provider and environment.
 * 
 * @param config - Database configuration to validate
 * @param logger - Optional logger for info messages
 * @throws {Error} If configuration is invalid for production
 */
export function validateDbConfig(config: DbConfig, logger?: AppLogger): void {
  const env = process.env.NODE_ENV || 'development';

  // PostgreSQL validation in production
  if (config.provider === 'postgresql') {
    if (env === 'production') {
      if (!config.host || !config.database) {
        throw new Error(
          `[DB Config] ❌ Production ${config.provider} requires host and database in DATABASE_URL`
        );
      }
    }
  }

  logger?.info(`[DB Config] ✓ Validated configuration for ${config.provider}`);
}

/**
 * Gets the current DATABASE_URL from environment.
 * 
 * @returns Current DATABASE_URL or undefined if not set
 */
export function getCurrentDatabaseUrl(): string | undefined {
  return process.env.DATABASE_URL;
}

/**
 * Checks if current environment is production.
 * 
 * @returns True if NODE_ENV is 'production'
 */
export function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

/**
 * Checks if current environment is test.
 * 
 * @returns True if NODE_ENV is 'test'
 */
export function isTest(): boolean {
  return process.env.NODE_ENV === 'test';
}