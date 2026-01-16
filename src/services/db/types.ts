// src/db/types.ts
import type { FastifyBaseLogger } from 'fastify';
import type { PrismaClient } from '@prisma/client';

/**
 * Supported database providers for multi-database support.
 * - postgresql: PostgreSQL database
 * - sqlite: SQLite database (file-based)
 */
export type DbProvider = 'postgresql' | 'sqlite';

/**
 * Database configuration extracted from DATABASE_URL.
 * Contains all necessary connection details for the detected provider.
 */
export interface DbConfig {
  /** Database provider type */
  provider: DbProvider;
  
  /** Full connection string/URL */
  connectionString: string;
  
  /** Database host (PostgreSQL only) */
  host?: string;
  
  /** Database port (PostgreSQL only) */
  port?: number;
  
  /** Database username (PostgreSQL only) */
  user?: string;
  
  /** Database password (PostgreSQL only) */
  password?: string;
  
  /** Database name (PostgreSQL only) */
  database?: string;
}

/**
 * Result of a database connection attempt.
 * Includes success status and retry information.
 */
export interface ConnectionResult {
  /** Whether connection was successful */
  success: boolean;
  
  /** Connected Prisma client (only if success is true) */
  client?: PrismaClient;
  
  /** Error message (only if success is false) */
  error?: string;
  
  /** Number of retry attempts made */
  retries: number;
}

/**
 * Result of a Prisma CLI command execution.
 * Captures stdout, stderr, and exit status.
 */
export interface CommandResult {
  /** Whether command executed successfully (exit code 0) */
  success: boolean;
  
  /** Standard output lines from the command */
  output: string[];
  
  /** Standard error lines from the command */
  errors: string[];
  
  /** Command exit code (null if process error) */
  exitCode: number | null;
}

/**
 * Application logger type alias.
 * Uses Fastify's base logger for consistency across the application.
 */
export type AppLogger = FastifyBaseLogger;

/**
 * Database adapter instance type.
 * This is the runtime adapter that tells Prisma which database to use.
 */
export type DatabaseAdapter = any; // Prisma adapters don't have a common type yet