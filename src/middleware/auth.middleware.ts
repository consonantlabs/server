/**
 * @fileoverview Authentication Middleware
 * @module middleware/auth
 * 
 * Provides API key authentication for REST API endpoints.
 * 
 * HOW IT WORKS:
 * 1. Extract API key from X-API-Key header
 * 2. Hash the provided key
 * 3. Query database for matching hash
 * 4. Verify key is not expired or revoked
 * 5. Update lastUsedAt timestamp
 * 6. Inject organizationId into request context
 * 
 * SECURITY:
 * - Timing-safe hash comparison
 * - Automatic expiration checking
 * - Revocation support
 * - Rate limiting integration
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import { verifySecret } from '../utils/crypto.js';
import { logger } from '../utils/logger.js';
import { contextManager } from '../utils/context.js';
import { defaultRateLimiter } from '../services/redis/rate-limiter.js';

/**
 * Extend Fastify request to include authenticated organization ID.
 */
declare module 'fastify' {
  interface FastifyRequest {
    organizationId?: string;
    apiKeyId?: string;
  }
}

/**
 * Authenticate request using API key.
 * 
 * Extracts API key from X-API-Key header, validates it,
 * and injects organizationId into request.
 * 
 * @param request - Fastify request
 * @param reply - Fastify reply
 * 
 * @example
 * // In route registration:
 * app.get('/protected', {
 *   preHandler: authenticateApiKey,
 * }, handler);
 * 
 * // Or register globally:
 * app.addHook('preHandler', authenticateApiKey);
 */
export async function authenticateApiKey(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  try {
    // Extract API key from header
    const apiKey = request.headers['x-api-key'] as string;

    if (!apiKey) {
      logger.warn('Missing API key in request');
      reply.code(401).send({
        success: false,
        error: 'Unauthorized',
        message: 'API key required. Provide X-API-Key header.',
      });
      return;
    }

    // Extract prefix for O(1) lookup
    const keyPrefix = apiKey.substring(0, 8);

    // Query API keys matching the prefix
    const apiKeys = await request.prisma.apiKey.findMany({
      where: {
        keyPrefix,
        revokedAt: null,
        OR: [
          { expiresAt: null },
          { expiresAt: { gt: new Date() } },
        ],
      },
      select: {
        id: true,
        keyHash: true,
        organizationId: true,
        rateLimit: true,
        rateLimitUsed: true,
      },
    });

    // Find matching key by comparing hashes (timing-safe)
    let matchedKey: typeof apiKeys[0] | null = null;

    for (const key of apiKeys) {
      const isMatch = await verifySecret(apiKey, key.keyHash);
      if (isMatch) {
        matchedKey = key;
        break;
      }
    }

    if (!matchedKey) {
      logger.warn('Invalid API key provided');
      reply.code(401).send({
        success: false,
        error: 'Unauthorized',
        message: 'Invalid API key',
      });
      return;
    }

    // Check rate limit
    const rateLimitResult = await defaultRateLimiter.check(matchedKey.id);

    if (!rateLimitResult.allowed) {
      logger.warn(
        {
          keyId: matchedKey.id,
          organizationId: matchedKey.organizationId,
        },
        'Rate limit exceeded'
      );

      reply.code(429)
        .headers(defaultRateLimiter.getHeaders(rateLimitResult))
        .send({
          success: false,
          error: 'Too Many Requests',
          message: 'Rate limit exceeded',
          retryAfter: rateLimitResult.retryAfter,
        });
      return;
    }

    // Update lastUsedAt timestamp (async, don't await)
    request.prisma.apiKey.update({
      where: { id: matchedKey.id },
      data: {
        lastUsedAt: new Date(),
        rateLimitUsed: rateLimitResult.current,
      },
    }).catch((err: Error) => {
      logger.error({ err }, 'Failed to update API key lastUsedAt');
    });

    // Inject IDs into request
    request.organizationId = matchedKey.organizationId;
    request.apiKeyId = matchedKey.id;

    // Inject into execution context
    contextManager.setOrganizationId(matchedKey.organizationId);

    // Add rate limit headers to response
    reply.headers(defaultRateLimiter.getHeaders(rateLimitResult));

    logger.debug(
      {
        organizationId: matchedKey.organizationId,
        keyId: matchedKey.id,
      },
      'API key authenticated successfully'
    );
  } catch (error) {
    logger.error({ err: error }, 'Authentication error');
    return reply.code(500).send({
      success: false,
      error: 'Internal Server Error',
      message: 'Authentication failed',
    });
  }
}

/**
 * Optional authentication middleware.
 * 
 * Attempts to authenticate but doesn't reject if no API key is provided.
 * Useful for endpoints that have both authenticated and unauthenticated access.
 * 
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function optionalApiKeyAuth(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const apiKey = request.headers['x-api-key'] as string;

  if (!apiKey) {
    // No API key provided, continue without authentication
    return;
  }

  // API key provided, validate it
  await authenticateApiKey(request, reply);
}