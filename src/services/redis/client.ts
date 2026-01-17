/**
 * @fileoverview Redis Client
 * @module services/redis/client
 * 
 * Provides Redis connection management with:
 * - Automatic reconnection
 * - Connection pooling
 * - Health checks
 * - Graceful shutdown
 * - Error handling
 * 
 * Redis is used for:
 * - Rate limiting (sliding window)
 * - Session storage
 * - Distributed locks
 * - Caching hot data
 */

import { Redis, type RedisOptions } from 'ioredis';
import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';


/**
 * Redis client configuration.
 */
const redisConfig: RedisOptions = {
  // Connection
  lazyConnect: true, // Don't connect immediately, wait for explicit connect()
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  enableOfflineQueue: true,

  // Reconnection strategy
  retryStrategy(times: number) {
    const delay = Math.min(times * 50, 2000);
    logger.warn({ times, delay }, 'Redis reconnecting...');
    return delay;
  },

  // Reconnect on error
  reconnectOnError(err: Error) {
    const targetErrors = ['READONLY', 'ECONNRESET', 'ETIMEDOUT'];
    return targetErrors.some(targetError => err.message.includes(targetError));
  },

  // Key prefix for namespacing
  keyPrefix: env.REDIS_PREFIX,
};

/**
 * Parse Redis URL into connection options.
 * 
 * Supports URLs like:
 * - redis://localhost:6379
 * - redis://:password@localhost:6379
 * - redis://localhost:6379/0 (with database number)
 * - rediss://localhost:6379 (TLS)
 * 
 * @param url - Redis connection URL
 * @returns Redis connection options
 */
function parseRedisUrl(url: string): RedisOptions {
  const parsedUrl = new URL(url);

  return {
    ...redisConfig,
    host: parsedUrl.hostname,
    port: parseInt(parsedUrl.port || '6379', 10),
    password: parsedUrl.password || undefined,
    db: parsedUrl.pathname ? parseInt(parsedUrl.pathname.slice(1), 10) : 0,
    tls: parsedUrl.protocol === 'rediss:' ? {} : undefined,
  };
}

/**
 * Redis client instance.
 */
class RedisClient {
  private client: Redis;
  private isConnected: boolean = false;

  constructor() {
    const options = parseRedisUrl(env.REDIS_URL);
    this.client = new Redis(options);
    this.setupEventHandlers();
  }

  /**
   * Set up Redis event handlers for logging and monitoring.
   */
  private setupEventHandlers(): void {
    this.client.on('connect', () => {
      logger.info('Redis client connecting...');
    });

    this.client.on('ready', () => {
      this.isConnected = true;
      logger.info('Redis client ready');
    });

    this.client.on('error', (error: Error) => {
      logger.error({ err: error }, 'Redis client error');
    });

    this.client.on('close', () => {
      this.isConnected = false;
      logger.warn('Redis client closed');
    });

    this.client.on('reconnecting', (delay: number) => {
      logger.info({ delay }, 'Redis client reconnecting');
    });

    this.client.on('end', () => {
      this.isConnected = false;
      logger.info('Redis client ended');
    });
  }

  /**
   * Connect to Redis.
   * 
   * @throws {Error} If connection fails
   */
  async connect(): Promise<void> {
    try {
      await this.client.connect();
      logger.info('Redis client connected successfully');
    } catch (error) {
      logger.error({ err: error }, 'Failed to connect to Redis');
      throw error;
    }
  }

  /**
   * Disconnect from Redis gracefully.
   */
  async disconnect(): Promise<void> {
    try {
      await this.client.quit();
      logger.info('Redis client disconnected');
    } catch (error) {
      logger.error({ err: error }, 'Error disconnecting Redis client');
      // Force quit if graceful shutdown fails
      this.client.disconnect();
    }
  }

  /**
   * Check if Redis is connected and ready.
   * 
   * @returns True if connected
   */
  isReady(): boolean {
    return this.isConnected && this.client.status === 'ready';
  }

  /**
   * Ping Redis to check connectivity.
   * 
   * @returns True if ping successful
   */
  async ping(): Promise<boolean> {
    try {
      const result = await this.client.ping();
      return result === 'PONG';
    } catch (error) {
      logger.error({ err: error }, 'Redis ping failed');
      return false;
    }
  }

  /**
   * Get the underlying ioredis client.
   * 
   * Use this to access the full Redis API.
   * 
   * @returns ioredis client
   */
  getClient(): Redis {
    return this.client;
  }

  /**
   * Get a value from Redis.
   * 
   * @param key - Key to get (prefix automatically added)
   * @returns Value or null if not found
   */
  async get(key: string): Promise<string | null> {
    return await this.client.get(key);
  }

  /**
   * Get a JSON value from Redis.
   * 
   * @param key - Key to get
   * @returns Parsed JSON value or null
   */
  async getJSON<T>(key: string): Promise<T | null> {
    const value = await this.client.get(key);
    if (!value) {
      return null;
    }

    try {
      return JSON.parse(value) as T;
    } catch (error) {
      logger.error({ err: error, key }, 'Failed to parse JSON from Redis');
      return null;
    }
  }

  /**
   * Set a value in Redis.
   * 
   * @param key - Key to set
   * @param value - Value to set
   * @param ttl - Time to live in seconds (optional)
   */
  async set(key: string, value: string, ttl?: number): Promise<void> {
    if (ttl) {
      await this.client.setex(key, ttl, value);
    } else {
      await this.client.set(key, value);
    }
  }

  /**
   * Set a JSON value in Redis.
   * 
   * @param key - Key to set
   * @param value - Value to set (will be JSON stringified)
   * @param ttl - Time to live in seconds (optional)
   */
  async setJSON<T>(key: string, value: T, ttl?: number): Promise<void> {
    const json = JSON.stringify(value);
    await this.set(key, json, ttl);
  }

  /**
   * Delete a key from Redis.
   * 
   * @param key - Key to delete
   * @returns Number of keys deleted (0 or 1)
   */
  async del(key: string): Promise<number> {
    return await this.client.del(key);
  }

  /**
   * Delete multiple keys from Redis.
   * 
   * @param keys - Keys to delete
   * @returns Number of keys deleted
   */
  async delMany(keys: string[]): Promise<number> {
    if (keys.length === 0) {
      return 0;
    }
    return await this.client.del(...keys);
  }

  /**
   * Check if a key exists in Redis.
   * 
   * @param key - Key to check
   * @returns True if key exists
   */
  async exists(key: string): Promise<boolean> {
    const result = await this.client.exists(key);
    return result === 1;
  }

  /**
   * Set expiration on a key.
   * 
   * @param key - Key to expire
   * @param ttl - Time to live in seconds
   * @returns True if expiration was set
   */
  async expire(key: string, ttl: number): Promise<boolean> {
    const result = await this.client.expire(key, ttl);
    return result === 1;
  }

  /**
   * Get time to live for a key.
   * 
   * @param key - Key to check
   * @returns TTL in seconds, -1 if no expiry, -2 if key doesn't exist
   */
  async ttl(key: string): Promise<number> {
    return await this.client.ttl(key);
  }

  /**
   * Increment a counter.
   * 
   * @param key - Key to increment
   * @returns New value after increment
   */
  async incr(key: string): Promise<number> {
    return await this.client.incr(key);
  }

  /**
   * Increment a counter by a specific amount.
   * 
   * @param key - Key to increment
   * @param amount - Amount to increment by
   * @returns New value after increment
   */
  async incrBy(key: string, amount: number): Promise<number> {
    return await this.client.incrby(key, amount);
  }

  /**
   * Decrement a counter.
   * 
   * @param key - Key to decrement
   * @returns New value after decrement
   */
  async decr(key: string): Promise<number> {
    return await this.client.decr(key);
  }

  /**
   * Get all keys matching a pattern.
   * 
   * WARNING: This is O(N) where N is the number of keys.
   * Use SCAN in production for large datasets.
   * 
   * @param pattern - Pattern to match (e.g., "user:*")
   * @returns Array of matching keys
   */
  async keys(pattern: string): Promise<string[]> {
    return await this.client.keys(pattern);
  }

  /**
   * Scan keys matching a pattern (production-safe).
   * 
   * Uses SCAN cursor to avoid blocking Redis.
   * 
   * @param pattern - Pattern to match
   * @returns Array of matching keys
   */
  async scan(pattern: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor = '0';

    do {
      const [nextCursor, foundKeys] = await this.client.scan(
        cursor,
        'MATCH',
        pattern,
        'COUNT',
        '100'
      );
      cursor = nextCursor;
      keys.push(...foundKeys);
    } while (cursor !== '0');

    return keys;
  }

  /**
   * Flush all keys from current database.
   * 
   * WARNING: This deletes ALL data in the current DB.
   * Use only in development/testing.
   */
  async flushDb(): Promise<void> {
    if (env.NODE_ENV === 'production') {
      throw new Error('Cannot flush Redis in production');
    }
    await this.client.flushdb();
    logger.warn('Redis database flushed');
  }

  /**
   * Get info about Redis server.
   * 
   * @returns Redis INFO output
   */
  async info(): Promise<string> {
    return await this.client.info();
  }

  /**
   * Get Redis server statistics.
   * 
   * @returns Parsed statistics
   */
  async getStats(): Promise<{
    connectedClients: number;
    usedMemory: number;
    totalKeys: number;
    uptime: number;
  }> {
    const info = await this.info();
    const lines = info.split('\r\n');

    const stats: Record<string, string> = {};
    for (const line of lines) {
      const [key, value] = line.split(':');
      if (key && value) {
        stats[key] = value;
      }
    }

    return {
      connectedClients: parseInt(stats.connected_clients || '0', 10),
      usedMemory: parseInt(stats.used_memory || '0', 10),
      totalKeys: parseInt(stats.db0?.match(/keys=(\d+)/)?.[1] || '0', 10),
      uptime: parseInt(stats.uptime_in_seconds || '0', 10),
    };
  }

  /**
   * Create a namespaced key.
   * 
   * Adds a namespace prefix to a key for organization.
   * 
   * @param namespace - Namespace (e.g., 'ratelimit', 'session')
   * @param key - Key within namespace
   * @returns Namespaced key
   * 
   * @example
   * const key = redisClient.key(REDIS_KEYS.RATE_LIMIT, userId);
   * // Returns: "consonant:ratelimit:user-123"
   */
  key(namespace: string, key: string): string {
    // Prefix is already added by ioredis config
    return `${namespace}:${key}`;
  }
}

/**
 * Singleton Redis client instance.
 * 
 * Import this throughout the application for Redis access.
 */
export const redisClient = new RedisClient();