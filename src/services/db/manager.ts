/**
 * @fileoverview Prisma Client Manager
 * @module services/db/manager
 * 
 * Thread-safe Prisma client manager for production environments.
 * 
 * DESIGN PRINCIPLES:
 * - DATABASE_URL read once at startup
 * - Any env change requires full application restart with SIGTERM
 * - Immutable after initialization
 * - Logger injected once, stored in memory
 * 
 * FEATURES:
 * - Singleton pattern for single client instance
 * - Thread-safe operations using mutex
 * - Connection retry logic
 * - Active request tracking for graceful shutdown
 * - Proper logger injection (no globals)
 * 
 * LIFECYCLE:
 * 1. Server calls initialize(logger) at startup
 * 2. Manager creates client, connects, stores in memory
 * 3. Requests use getClient() to access the same instance
 * 4. Server calls disconnect() during shutdown
 */

import { PrismaClient } from '@prisma/client';
import { Mutex } from 'async-mutex';
import { createAdapter } from './adapter.js';
import { connectWithRetry, disconnect } from './connection.js';
import type { AppLogger } from './types.js';

/**
 * Prisma client manager singleton.
 */
class PrismaManager {
  /** Singleton Prisma client instance (null until initialized) */
  private client: PrismaClient | null = null;

  /** Telemetry Prisma client instance (TimescaleDB) */
  private telemetryClient: PrismaClient | null = null;

  /** Current DATABASE_URL (stored at initialization, read-only) */
  private currentDatabaseUrl: string | null = null;

  /** Mutex for thread-safe operations */
  private mutex = new Mutex();

  /** Counter for active requests (for graceful shutdown) */
  private activeRequests = 0;

  /** Flag indicating if manager has been initialized */
  private isInitialized = false;

  /** Logger instance (injected once at initialization) */
  private logger: AppLogger | null = null;

  /**
   * Initialize the Prisma clients.
   * 
   * @param logger - Fastify logger instance (required)
   * @param dbUrl - Optional operational database URL override
   * @param telemetryUrl - Optional telemetry database URL override
   */
  async initialize(logger: AppLogger, dbUrl?: string, telemetryUrl?: string): Promise<void> {
    return this.mutex.runExclusive(async () => {
      if (this.isInitialized) {
        logger.info('[Prisma Manager] Already initialized, skipping...');
        return;
      }

      const databaseUrl = dbUrl || process.env.DATABASE_URL;
      const timeScaleUrl = telemetryUrl || process.env.TIMESCALE_DB_URL;

      if (!databaseUrl) {
        throw new Error('[Prisma Manager] DATABASE_URL not set');
      }

      this.logger = logger;
      logger.info('[Prisma Manager] Initializing clients...');

      // 1. Initialize Operational Client
      const operationalAdapter = createAdapter(logger, databaseUrl);
      this.client = new PrismaClient({
        adapter: operationalAdapter,
        log: [
          { level: 'query', emit: 'event' },
          { level: 'error', emit: 'event' },
          { level: 'warn', emit: 'event' },
        ],
      });
      this.wireLogging(this.client, logger);
      await connectWithRetry(this.client, logger);
      this.currentDatabaseUrl = databaseUrl;

      // 2. Initialize Telemetry Client (if configured)
      if (timeScaleUrl) {
        logger.info('[Prisma Manager] Initializing telemetry client (TimescaleDB)...');
        const telemetryAdapter = createAdapter(logger, timeScaleUrl);
        this.telemetryClient = new PrismaClient({
          adapter: telemetryAdapter,
          log: [
            { level: 'error', emit: 'event' },
            { level: 'warn', emit: 'event' },
          ],
        });
        this.wireLogging(this.telemetryClient, logger);
        await connectWithRetry(this.telemetryClient, logger);
      }

      this.isInitialized = true;
      logger.info('[Prisma Manager] ✓ Initialized successfully');
    });
  }

  /**
   * Wire Prisma's internal logging to our application logger.
   * 
   * @param client - Prisma client instance
   * @param logger - Application logger
   */
  private wireLogging(client: PrismaClient, logger: AppLogger): void {
    client.$on('query' as never, (e: any) => {
      logger.debug(`[Prisma] Query: ${e.query} (${e.duration}ms)`);
    });

    client.$on('error' as never, (e: any) => {
      logger.error(`[Prisma] Error: ${e.message}`);
    });

    client.$on('warn' as never, (e: any) => {
      logger.warn(`[Prisma] Warning: ${e.message}`);
    });
  }

  /**
   * Get the current Prisma client instance.
   * 
   * Usage: Call this in your routes/services whenever you need to access the database.
   * 
   * @returns Prisma client instance
   * @throws {Error} If manager is not initialized
   */
  async getClient(): Promise<PrismaClient> {
    if (!this.client) {
      const error = '[Prisma Manager] ❌ Client not initialized. Call initialize(logger) first.';
      this.logger?.error(error);
      throw new Error(error);
    }

    return this.client;
  }

  /**
   * Get the telemetry Prisma client instance (TimescaleDB).
   * Falls back to the main client if TIMESCALE_DB_URL is not set.
   * 
   * @returns Telemetry Prisma client instance
   */
  async getTelemetryClient(): Promise<PrismaClient> {
    if (!this.telemetryClient) {
      // If telemetry client is not initialized, fall back to main client
      // (Used when operational and telemetry share the same DB)
      return this.getClient();
    }

    return this.telemetryClient;
  }

  /**
   * Get current database URL (read-only).
   * 
   * @returns Current DATABASE_URL or null if not initialized
   */
  getCurrentDatabaseUrl(): string | null {
    return this.currentDatabaseUrl;
  }

  /**
   * Check if manager is initialized and ready.
   * 
   * @returns True if initialized with a connected client
   */
  isReady(): boolean {
    return this.isInitialized && this.client !== null;
  }

  /**
   * Increment active request counter.
   * 
   * Usage: Called automatically by Fastify middleware on request start.
   */
  incrementActiveRequests(): void {
    this.activeRequests++;
  }

  /**
   * Decrement active request counter.
   * 
   * Usage: Called automatically by Fastify middleware on request completion.
   */
  decrementActiveRequests(): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
  }

  /**
   * Get current number of active requests.
   * 
   * @returns Active request count
   */
  getActiveRequestCount(): number {
    return this.activeRequests;
  }

  /**
   * Gracefully disconnect client and reset state.
   * 
   * Called during shutdown (SIGTERM/SIGINT) by the server.
   * 
   * What it does:
   * 1. Waits for active requests to complete (up to 10s)
   * 2. Disconnects Prisma client
   * 3. Resets all internal state
   * 4. Marks as uninitialized
   * 
   * @throws {Error} If disconnect fails
   */
  async disconnect(): Promise<void> {
    return this.mutex.runExclusive(async () => {
      if (!this.client) {
        this.logger?.info('[Prisma Manager] No client to disconnect');
        return;
      }

      this.logger?.info('[Prisma Manager] Disconnecting client...');

      // Wait for active requests to complete
      await this.waitForActiveRequests();

      // Disconnect client
      await disconnect(this.client, this.logger!);

      // Reset state
      this.client = null;
      this.currentDatabaseUrl = null;
      this.isInitialized = false;

      this.logger?.info('[Prisma Manager] ✓ Disconnected successfully');
    });
  }

  /**
   * Wait for active requests to complete with timeout.
   * 
   * @param maxWaitMs - Maximum wait time in milliseconds (default: 10000)
   */
  private async waitForActiveRequests(maxWaitMs: number = 10000): Promise<void> {
    const startTime = Date.now();

    while (this.activeRequests > 0 && (Date.now() - startTime) < maxWaitMs) {
      this.logger?.info(
        `[Prisma Manager] Waiting for ${this.activeRequests} active requests...`
      );
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    if (this.activeRequests > 0) {
      this.logger?.warn(
        `[Prisma Manager] ⚠ Force disconnecting with ${this.activeRequests} active requests`
      );
    }
  }

  /**
   * Reset manager to uninitialized state.
   * 
   * Use case: Testing or emergency cleanup.
   * In production, just call disconnect().
   */
  async reset(): Promise<void> {
    await this.disconnect();
    this.logger?.info('[Prisma Manager] Reset complete');
  }
}

/**
 * Singleton instance of PrismaManager.
 * 
 * This is the ONLY instance you should use throughout your application.
 */
export const prismaManager = new PrismaManager();