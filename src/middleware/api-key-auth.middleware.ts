/**
 * @fileoverview API Key Authentication Middleware
 * @module middleware/api-key-auth
 * 
 * This middleware validates API keys for all incoming requests to protected routes.
 * It uses bcrypt to securely compare the provided key against stored hashes.
 * 
 * SECURITY ARCHITECTURE:
 * - API keys are never stored in plaintext - only bcrypt hashes
 * - Comparison uses timing-safe algorithms to prevent timing attacks
 * - Failed attempts are logged for security monitoring
 * - Rate limiting is enforced per API key
 * 
 * INTEGRATION:
 * The middleware injects apiKeyId and apiKeyHash into the request object
 * so downstream handlers can identify which customer is making the request.
 */

import { FastifyRequest, FastifyReply } from 'fastify';
import { verifySecret } from '../utils/crypto.js';
import { prismaManager } from '../services/db/manager.js';
import { logger } from '../utils/logger.js';

/**
 * Extract API key from request headers.
 * Supports both X-API-Key and Authorization: Bearer headers.
 * 
 * @param request - Fastify request object
 * @returns API key string or null if not found
 */
function extractApiKey(request: FastifyRequest): string | null {
  // Try X-API-Key header first (preferred)
  const xApiKey = request.headers['x-api-key'];
  if (xApiKey && typeof xApiKey === 'string') {
    return xApiKey;
  }

  // Fall back to Authorization: Bearer header
  const authHeader = request.headers['authorization'];
  if (authHeader && typeof authHeader === 'string') {
    const match = authHeader.match(/^Bearer\s+(.+)$/);
    if (match) {
      return match[1];
    }
  }

  return null;
}

/**
 * Validate API key and enforce rate limits.
 * 
 * This middleware:
 * 1. Extracts the API key from headers
 * 2. Finds the key in the database (by trying all stored hashes)
 * 3. Verifies the key hasn't expired
 * 4. Checks rate limits
 * 5. Updates last used timestamp
 * 6. Injects key metadata into request
 * 
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function apiKeyAuthMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
) {
  const apiKey = extractApiKey(request);

  if (!apiKey) {
    logger.warn({
      path: request.url,
      ip: request.ip,
    }, 'Request missing API key');

    return reply.code(401).send({
      error: 'Unauthorized',
      message: 'API key required. Provide key in X-API-Key header or Authorization: Bearer header.',
    });
  }

  try {
    // Use prismaManager
    const prisma = await prismaManager.getClient();

    // Optimized lookup: API keys are now formatted as "prefix.secret"
    // We can extract the prefix and query by it.
    const [prefix] = apiKey.split('.');

    if (!prefix) {
      return reply.code(401).send({
        error: 'Unauthorized',
        message: 'Invalid API key format',
      });
    }

    const keyRecords = await prisma.apiKey.findMany({
      where: {
        keyPrefix: prefix,
        expiresAt: {
          gt: new Date(),
        },
      },
      select: {
        id: true,
        keyHash: true,
        name: true,
        organizationId: true,
        rateLimit: true,
        rateLimitUsed: true,
        rateLimitReset: true,
        lastUsedAt: true,
      },
    });

    // Find the matching key by comparing hashes
    let matchedKey = null;
    for (const key of keyRecords) {
      if (await verifySecret(apiKey, key.keyHash)) {
        matchedKey = key;
        break;
      }
    }

    if (!matchedKey) {
      logger.warn({
        path: request.url,
        ip: request.ip,
      }, 'Invalid API key provided');

      return reply.code(401).send({
        error: 'Unauthorized',
        message: 'Invalid API key',
      });
    }

    // Check rate limit
    const now = new Date();
    const resetTime = new Date(matchedKey.rateLimitReset);

    // Reset counter if window has passed
    if (now > resetTime) {
      await prisma.apiKey.update({
        where: { id: matchedKey.id },
        data: {
          rateLimitUsed: 1,
          rateLimitReset: new Date(now.getTime() + 60000), // 1 minute window
          lastUsedAt: now,
        },
      });
    } else {
      // Check if limit exceeded
      if (matchedKey.rateLimitUsed >= matchedKey.rateLimit) {
        const retryAfter = Math.ceil((resetTime.getTime() - now.getTime()) / 1000);

        logger.warn({
          apiKeyId: matchedKey.id,
          path: request.url,
          rateLimit: matchedKey.rateLimit,
        }, 'Rate limit exceeded');

        return reply
          .code(429)
          .header('X-RateLimit-Limit', matchedKey.rateLimit.toString())
          .header('X-RateLimit-Remaining', '0')
          .header('X-RateLimit-Reset', resetTime.toISOString())
          .header('Retry-After', retryAfter.toString())
          .send({
            error: 'Too many requests',
            message: `Rate limit exceeded. Try again in ${retryAfter} seconds.`,
            retryAfter,
          });
      }

      // Increment usage counter
      await prisma.apiKey.update({
        where: { id: matchedKey.id },
        data: {
          rateLimitUsed: matchedKey.rateLimitUsed + 1,
          lastUsedAt: now,
        },
      });
    }

    // Inject API key metadata into request
    // Downstream handlers can access (request as any).apiKeyId
    (request as any).apiKeyId = matchedKey.id;
    (request as any).apiKeyHash = matchedKey.keyHash;
    (request as any).apiKeyName = matchedKey.name;
    (request as any).organizationId = matchedKey.organizationId;

    logger.debug({
      apiKeyId: matchedKey.id,
      apiKeyName: matchedKey.name,
      path: request.url,
    }, 'API key authenticated successfully');
  } catch (error) {
    logger.error({ error }, 'Error during API key authentication');

    return reply.code(500).send({
      error: 'Internal server error',
      message: 'Authentication failed',
    });
  } finally {
    // Security: Do not disconnect singleton client here
  }
}

/**
 * Register the authentication middleware with Fastify.
 * This should be called before registering protected routes.
 * 
 * @param fastify - Fastify instance
 */
export async function registerAuthMiddleware(fastify: any) {
  // Apply to all /api/* routes
  fastify.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    // Only apply to API routes
    if (request.url.startsWith('/api/')) {
      await apiKeyAuthMiddleware(request, reply);
    }
  });

  logger.info('API key authentication middleware registered');
}