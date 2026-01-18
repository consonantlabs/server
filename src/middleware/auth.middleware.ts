/**
 * @fileoverview Unified Authentication Middleware (Passport.js Powered)
 * @module middleware/auth
 * 
 * Provides unified authentication using Passport.js strategies.
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import passport from '@fastify/passport';
import { logger } from '../utils/logger.js';
import { contextManager } from '../utils/context.js';

/**
 * Unified Authentication Hook
 * 
 * Attempts to authenticate using both API Key and JWT strategies.
 * If neither succeeds, returns 401.
 */
export async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  // 1. Try strategies in priority order
  // Note: passport.authenticate returns a preHandler function in @fastify/passport
  // We use the 'multi' capability or just chain them

  try {
    // Try API Key first (Fastest/SDK path)
    const apiKeyAuth = await (request as any).passport.authenticate('api-key', { session: false })(request, reply);
    if (request.user) {
      const user = request.user as any;
      request.organizationId = user.organizationId;
      request.apiKeyId = user.id;
      contextManager.setOrganizationId(user.organizationId);
      return;
    }

    // Try JWT second (User/Dashboard path)
    await (request as any).passport.authenticate('jwt', { session: false })(request, reply);
    if (request.user) {
      const user = request.user as any;
      request.userId = user.id;
      contextManager.setUserId(user.id);

      // If user has a default/current org, hydrate it
      if (user.organizations && user.organizations.length > 0) {
        const orgId = user.organizations[0].organizationId;
        request.organizationId = orgId;
        contextManager.setOrganizationId(orgId);
      }
      return;
    }

    // 2. Fallback: Unauthorized
    logger.warn({ path: request.url, ip: request.ip }, 'Authentication failed - all strategies exhausted');
    return reply.code(401).send({
      success: false,
      error: 'Unauthorized',
      message: 'Authentication required. Provide valid X-API-Key or Bearer Token.',
    });

  } catch (error) {
    logger.error({ err: error }, 'Passport authentication subsystem error');
    return reply.code(500).send({
      success: false,
      error: 'Internal Server Error',
      message: 'Authentication failed',
    });
  }
}

/**
 * Optional Authentication
 * Hydrates context if credentials are valid, but doesn't block if missing.
 */
export async function optionalAuthenticate(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const authHeader = request.headers['authorization'];
  const apiKeyHeader = request.headers['x-api-key'];

  if (!authHeader && !apiKeyHeader) return;

  try {
    await authenticate(request, reply);
  } catch (err) {
    // Silently ignore failures for optional auth, just don't hydrate
    logger.debug({ err }, 'Optional auth failed, continuing unauthenticated');
  }
}

export class AuthenticateError extends Error {
  constructor(message: string, public statusCode: number = 401) {
    super(message);
  }
}