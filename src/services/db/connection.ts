/**
 * @fileoverview Database Connection
 * @module services/db/connection
 * 
 * Connects a Prisma client with exponential backoff retry logic.
 * 
 * RETRY STRATEGY:
 * - Initial delay: 1 second
 * - Exponential backoff: delay doubles each attempt
 * - Max delay: 30 seconds
 * - Max retries: 5 attempts
 * 
 * CONNECTION TESTING:
 * - After successful connection, runs a test query (SELECT 1)
 * - Ensures database is not just accepting connections but actually responding
 */

import { PrismaClient } from '@prisma/client';
import { detectProvider } from './config.js';
import type { ConnectionResult, AppLogger } from './types.js';

/** Maximum number of connection attempts before giving up */
const MAX_RETRIES = 5;

/** Initial delay between retries in milliseconds */
const INITIAL_DELAY_MS = 1000;

/** Maximum delay between retries in milliseconds (caps exponential backoff) */
const MAX_DELAY_MS = 30000;

/**
 * Connects a Prisma client with exponential backoff retry logic.
 * 
 * @param client - Prisma client instance to connect
 * @param logger - Logger instance for diagnostic messages
 * @param maxRetries - Maximum number of connection attempts (default: 5)
 * @returns Connection result with success status and retry count
 * 
 * @example
 * const client = new PrismaClient({ adapter });
 * const result = await connectWithRetry(client, logger);
 * 
 * if (result.success) {
 *   console.log(`Connected after ${result.retries} retries`);
 * } else {
 *   console.error(`Failed: ${result.error}`);
 * }
 */
export async function connectWithRetry(
  client: PrismaClient,
  logger: AppLogger,
  maxRetries: number = MAX_RETRIES
): Promise<ConnectionResult> {
  // Detect provider for logging
  const dbConfig = detectProvider(logger);

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      logger.info(
        `[DB Connection] Attempt ${attempt + 1}/${maxRetries} to connect to ${dbConfig.provider}...`
      );

      // Establish connection to database
      await client.$connect();

      // Test the connection with a simple query
      await testConnection(client, dbConfig.provider, logger);

      // Success!
      const retryMessage = attempt > 0 ? ` after ${attempt} retries` : '';
      logger.info(
        `[DB Connection] ✓ Connected to ${dbConfig.provider}${retryMessage}`
      );

      return {
        success: true,
        client,
        retries: attempt,
      };
    } catch (error) {
      const isLastAttempt = attempt === maxRetries - 1;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      logger.error(
        `[DB Connection] Attempt ${attempt + 1}/${maxRetries} failed: ${errorMessage}`
      );

      // If this was the last attempt, give up
      if (isLastAttempt) {
        await disconnectSafely(client, logger);

        return {
          success: false,
          error: errorMessage,
          retries: attempt + 1,
        };
      }

      // Calculate next retry delay with exponential backoff
      const delay = calculateBackoffDelay(attempt);

      logger.info(`[DB Connection] Retrying in ${delay / 1000}s...`);
      await sleep(delay);
    }
  }

  // Should never reach here due to the loop logic, but TypeScript needs this
  return {
    success: false,
    error: 'Max retries exceeded',
    retries: maxRetries,
  };
}

/**
 * Tests database connection with a provider-specific query.
 * 
 * TEST QUERIES:
 * - PostgreSQL: SELECT 1
 * - SQLite: SELECT 1
 * 
 * @param client - Connected Prisma client
 * @param provider - Database provider type
 * @param logger - Logger instance
 * @throws {Error} If test query fails
 */
async function testConnection(
  client: PrismaClient,
  _provider: string,
  logger: AppLogger
): Promise<void> {
  try {
    // All providers support SELECT 1
    await client.$queryRaw`SELECT 1`;
    logger.info('[DB Connection] ✓ Connection test passed');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[DB Connection] ❌ Connection test failed: ${errorMessage}`);
    throw error;
  }
}

/**
 * Calculates exponential backoff delay for retry attempts.
 * 
 * FORMULA: min(INITIAL_DELAY * 2^attempt, MAX_DELAY)
 * 
 * @param attempt - Current attempt number (0-indexed)
 * @returns Delay in milliseconds
 * 
 * @example
 * calculateBackoffDelay(0); // 1000ms (1s)
 * calculateBackoffDelay(1); // 2000ms (2s)
 * calculateBackoffDelay(2); // 4000ms (4s)
 * calculateBackoffDelay(3); // 8000ms (8s)
 * calculateBackoffDelay(4); // 16000ms (16s)
 * calculateBackoffDelay(5); // 30000ms (30s - capped)
 */
function calculateBackoffDelay(attempt: number): number {
  const exponentialDelay = INITIAL_DELAY_MS * Math.pow(2, attempt);
  return Math.min(exponentialDelay, MAX_DELAY_MS);
}

/**
 * Sleep for specified duration.
 * 
 * @param ms - Duration in milliseconds
 * @returns Promise that resolves after the duration
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Safely disconnects a Prisma client, catching and logging any errors.
 * 
 * @param client - Prisma client to disconnect
 * @param logger - Logger instance
 */
async function disconnectSafely(client: PrismaClient, logger: AppLogger): Promise<void> {
  try {
    await client.$disconnect();
    logger.info('[DB Connection] ✓ Disconnected after failed connection');
  } catch (disconnectError) {
    const errorMessage = disconnectError instanceof Error
      ? disconnectError.message
      : 'Unknown error';
    logger.warn(`[DB Connection] Failed to disconnect: ${errorMessage}`);
  }
}

/**
 * Gracefully disconnects a Prisma client.
 * 
 * Use this for normal shutdowns, not after failed connections.
 * 
 * @param client - Prisma client to disconnect
 * @param logger - Logger instance
 * @throws {Error} If disconnect fails
 * 
 * @example
 * await disconnect(client, logger);
 * console.log('Database disconnected');
 */
export async function disconnect(client: PrismaClient, logger: AppLogger): Promise<void> {
  try {
    await client.$disconnect();
    logger.info('[DB Connection] ✓ Disconnected successfully');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[DB Connection] ❌ Error during disconnect: ${errorMessage}`);
    throw error;
  }
}

/**
 * Checks if a Prisma client is currently connected.
 * 
 * Note: This performs an actual database query to verify connectivity.
 * 
 * @param client - Prisma client to check
 * @param logger - Logger instance
 * @returns True if connected and responsive
 */
export async function isConnected(client: PrismaClient, logger: AppLogger): Promise<boolean> {
  try {
    await client.$queryRaw`SELECT 1`;
    return true;
  } catch (error) {
    logger.warn('[DB Connection] Connection check failed');
    return false;
  }
}