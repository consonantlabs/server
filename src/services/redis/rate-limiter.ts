/**
 * @fileoverview Redis Rate Limiter
 * @module services/redis/rate-limiter
 * 
 * Implements a sliding window rate limiter using Redis.
 * This provides distributed rate limiting that works across multiple
 * server instances.
 * 
 * Algorithm: Fixed Window Counter with Sliding Window
 * - More accurate than simple fixed window
 * - More efficient than pure sliding window
 * - Good balance of accuracy and performance
 * 
 * Features:
 * - Distributed rate limiting (works across multiple servers)
 * - Per-API-key limits
 * - Configurable windows and limits
 * - Proper 429 responses with Retry-After
 * - Rate limit headers (X-RateLimit-*)
 */

import { redisClient } from './client.js';
import { REDIS_KEYS, RATE_LIMITS } from '@/config/constants.js';
import { logger } from '@/utils/logger.js';

/**
 * Rate limit configuration for a specific endpoint or resource.
 */
export interface RateLimitConfig {
  /** Maximum requests allowed in window */
  max: number;
  
  /** Window duration in milliseconds */
  windowMs: number;
  
  /** Optional key prefix for namespacing */
  prefix?: string;
}

/**
 * Rate limit result with current state.
 */
export interface RateLimitResult {
  /** Whether the request is allowed */
  allowed: boolean;
  
  /** Current request count in window */
  current: number;
  
  /** Maximum requests allowed */
  limit: number;
  
  /** Remaining requests in window */
  remaining: number;
  
  /** Time until window reset (milliseconds) */
  resetMs: number;
  
  /** Time to wait before retry (seconds, only if not allowed) */
  retryAfter?: number;
}

/**
 * Rate limiter using Redis with sliding window algorithm.
 * 
 * Uses a hybrid approach:
 * 1. Current window counter
 * 2. Previous window counter
 * 3. Calculate rate based on overlap
 * 
 * This provides smooth rate limiting without sharp edges at window boundaries.
 */
export class RateLimiter {
  private config: Required<RateLimitConfig>;

  /**
   * Create a rate limiter instance.
   * 
   * @param config - Rate limit configuration
   * 
   * @example
   * const limiter = new RateLimiter({
   *   max: 100,
   *   windowMs: 60000, // 1 minute
   *   prefix: 'api',
   * });
   */
  constructor(config: RateLimitConfig) {
    this.config = {
      max: config.max,
      windowMs: config.windowMs,
      prefix: config.prefix || REDIS_KEYS.RATE_LIMIT,
    };
  }

  /**
   * Check rate limit for a key.
   * 
   * This is the main rate limiting function. It checks if the request
   * is allowed based on the sliding window algorithm.
   * 
   * @param key - Identifier to rate limit (e.g., API key, IP address)
   * @returns Rate limit result
   * 
   * @example
   * const result = await limiter.check(apiKey);
   * if (!result.allowed) {
   *   return reply.code(429).send({
   *     error: 'Rate limit exceeded',
   *     retryAfter: result.retryAfter,
   *   });
   * }
   */
  async check(key: string): Promise<RateLimitResult> {
    const now = Date.now();
    const currentWindow = Math.floor(now / this.config.windowMs);
    const previousWindow = currentWindow - 1;

    // Redis keys for current and previous windows
    const currentKey = this.getWindowKey(key, currentWindow);
    const previousKey = this.getWindowKey(key, previousWindow);

    // Use Redis pipeline for atomic operations
    const pipeline = redisClient.getClient().pipeline();
    
    // Increment current window counter
    pipeline.incr(currentKey);
    
    // Set expiration on current window (2x window to be safe)
    pipeline.expire(currentKey, Math.ceil(this.config.windowMs / 1000) * 2);
    
    // Get previous window count
    pipeline.get(previousKey);

    const results = await pipeline.exec();
    
    if (!results) {
      throw new Error('Redis pipeline execution failed');
    }

    // Parse results
    const currentCount = results[0]?.[1] as number || 1;
    const previousCount = parseInt(results[2]?.[1] as string || '0', 10);

    // Calculate position in current window (0.0 to 1.0)
    const windowPosition = (now % this.config.windowMs) / this.config.windowMs;

    // Sliding window calculation
    // Weight previous window count by how much of it overlaps with current time
    const weightedCount = Math.floor(
      previousCount * (1 - windowPosition) + currentCount
    );

    const allowed = weightedCount <= this.config.max;
    const remaining = Math.max(0, this.config.max - weightedCount);
    
    // Time until current window resets
    const resetMs = this.config.windowMs - (now % this.config.windowMs);
    
    // Calculate retry-after (in seconds) if limit exceeded
    let retryAfter: number | undefined;
    if (!allowed) {
      // Retry after window reset
      retryAfter = Math.ceil(resetMs / 1000);
    }

    const result: RateLimitResult = {
      allowed,
      current: weightedCount,
      limit: this.config.max,
      remaining,
      resetMs,
      retryAfter,
    };

    // Log rate limit events
    if (!allowed) {
      logger.warn(
        {
          key,
          current: weightedCount,
          limit: this.config.max,
          retryAfter,
        },
        'Rate limit exceeded'
      );
    }

    return result;
  }

  /**
   * Reset rate limit for a key.
   * 
   * Clears all rate limit counters for the given key.
   * Useful for testing or manual override.
   * 
   * @param key - Key to reset
   * 
   * @example
   * await limiter.reset(apiKey);
   */
  async reset(key: string): Promise<void> {
    const pattern = `${this.config.prefix}:${key}:*`;
    const keys = await redisClient.scan(pattern);
    
    if (keys.length > 0) {
      await redisClient.delMany(keys);
    }

    logger.info({ key }, 'Rate limit reset');
  }

  /**
   * Get current rate limit status without incrementing.
   * 
   * Useful for checking status without consuming a request.
   * 
   * @param key - Key to check
   * @returns Rate limit result (current state)
   */
  async status(key: string): Promise<RateLimitResult> {
    const now = Date.now();
    const currentWindow = Math.floor(now / this.config.windowMs);
    const previousWindow = currentWindow - 1;

    const currentKey = this.getWindowKey(key, currentWindow);
    const previousKey = this.getWindowKey(key, previousWindow);

    const [currentCount, previousCount] = await Promise.all([
      redisClient.get(currentKey).then(v => parseInt(v || '0', 10)),
      redisClient.get(previousKey).then(v => parseInt(v || '0', 10)),
    ]);

    const windowPosition = (now % this.config.windowMs) / this.config.windowMs;
    const weightedCount = Math.floor(
      previousCount * (1 - windowPosition) + currentCount
    );

    const allowed = weightedCount < this.config.max;
    const remaining = Math.max(0, this.config.max - weightedCount);
    const resetMs = this.config.windowMs - (now % this.config.windowMs);

    return {
      allowed,
      current: weightedCount,
      limit: this.config.max,
      remaining,
      resetMs,
    };
  }

  /**
   * Generate Redis key for a specific window.
   * 
   * @param key - Base key (API key, user ID, etc.)
   * @param window - Window number
   * @returns Redis key
   */
  private getWindowKey(key: string, window: number): string {
    return `${this.config.prefix}:${key}:${window}`;
  }

  /**
   * Get rate limit headers for HTTP response.
   * 
   * Returns standard rate limit headers as per IETF draft.
   * 
   * @param result - Rate limit result
   * @returns Headers object
   * 
   * @example
   * const result = await limiter.check(apiKey);
   * const headers = limiter.getHeaders(result);
   * reply.headers(headers);
   */
  getHeaders(result: RateLimitResult): Record<string, string> {
    const resetTime = new Date(Date.now() + result.resetMs);

    return {
      'X-RateLimit-Limit': result.limit.toString(),
      'X-RateLimit-Remaining': result.remaining.toString(),
      'X-RateLimit-Reset': Math.floor(resetTime.getTime() / 1000).toString(),
      ...(result.retryAfter && {
        'Retry-After': result.retryAfter.toString(),
      }),
    };
  }
}

/**
 * Create a rate limiter with default configuration.
 * 
 * @param config - Optional configuration (defaults to env settings)
 * @returns Rate limiter instance
 * 
 * @example
 * const limiter = createRateLimiter({ max: 100 });
 */
export function createRateLimiter(config?: Partial<RateLimitConfig>): RateLimiter {
  return new RateLimiter({
    max: config?.max || RATE_LIMITS.API_KEY_DEFAULT,
    windowMs: config?.windowMs || RATE_LIMITS.WINDOW_MS,
    prefix: config?.prefix || REDIS_KEYS.RATE_LIMIT,
  });
}

/**
 * Default rate limiter for API keys.
 * 
 * Uses configuration from constants.
 */
export const defaultRateLimiter = createRateLimiter();