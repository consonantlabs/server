import fp from 'fastify-plugin';
import rateLimit from '@fastify/rate-limit';
import { redisClient } from '../services/redis/client.js';
import { env } from '../config/env.js';

/**
 * Fastify plugin to configure rate limiting using Redis.
 * 
 * This implements a sliding window rate limiter to protect the API
 * from abuse and ensure fair usage across organizations.
 * 
 * CONFIGURATION:
 * - Uses 'X-API-Key' or 'Authorization' header for identification
 * - Falls back to IP address if no auth header is present
 * - Rates are configured via environment variables
 */
export default fp(async (fastify) => {
  await fastify.register(rateLimit, {
    global: true,
    max: env.RATE_LIMIT_MAX || 1000,
    timeWindow: env.RATE_LIMIT_WINDOW || '1 minute',
    redis: redisClient.getClient(),

    // Skip rate limiting in development if needed
    // skipOnError: true,

    keyGenerator: (request) => {
      // 1. Identify by API Key (if provided)
      const apiKey = request.headers['x-api-key'] as string;
      if (apiKey) return `ratelimit:apiKey:${apiKey.substring(0, 16)}`;

      // 2. Identify by JWT (if provided)
      const auth = request.headers.authorization;
      if (auth?.startsWith('Bearer ')) return `ratelimit:user:${auth.substring(7, 32)}`;

      // 3. Fallback to IP address
      return `ratelimit:ip:${request.ip}`;
    },

    errorResponseBuilder: (_request, context) => {
      const ttl = (context as any).ttl || (context as any).after || 60;
      return {
        statusCode: 429,
        error: 'Too Many Requests',
        message: `Rate limit exceeded. Try again in ${ttl}s.`,
        limit: context.max,
        window: ttl
      };
    }
  });

  fastify.log.info('✓ Rate limiting plugin registered (Redis)');
});
