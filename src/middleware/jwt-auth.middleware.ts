/**
 * @fileoverview JWT Authentication Middleware
 * @module middleware/jwt-auth
 * 
 * Validates JWT tokens from the Authorization header and sets userId on the request.
 * This middleware is used for user-authenticated endpoints (as opposed to API key auth).
 * 
 * AUTHENTICATION FLOW:
 * 1. Extract token from "Authorization: Bearer <token>" header
 * 2. Verify token signature and expiration
 * 3. Extract userId from token payload
 * 4. Set request.userId for downstream handlers
 * 5. Inject userId into execution context for logging
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import { verifyToken } from '@/controllers/auth.controller.js';
import { logger } from '@/utils/logger.js';
import { contextManager } from '@/utils/context.js';

/**
 * Authenticate request using JWT token.
 * 
 * Expects Authorization header with format: "Bearer <token>"
 * 
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function authenticateJWT(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const authHeader = request.headers.authorization;

  if (!authHeader) {
    logger.warn({ path: request.url }, 'Missing Authorization header');
    reply.code(401).send({
      success: false,
      error: 'Unauthorized',
      message: 'Authorization header required',
    });
    return;
  }

  // Extract token from "Bearer <token>"
  const parts = authHeader.split(' ');
  
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    logger.warn({ authHeader }, 'Invalid Authorization header format');
    reply.code(401).send({
      success: false,
      error: 'Unauthorized',
      message: 'Authorization header must be "Bearer <token>"',
    });
    return;
  }

  const token = parts[1];

  // Verify token
  const payload = verifyToken(token);

  if (!payload) {
    logger.warn({ token: token.substring(0, 20) + '...' }, 'Invalid or expired JWT token');
    reply.code(401).send({
      success: false,
      error: 'Unauthorized',
      message: 'Invalid or expired token',
    });
    return;
  }

  // Set userId on request
  request.userId = payload.userId;

  // Inject into execution context for logging
  contextManager.setUserId(payload.userId);

  logger.debug(
    {
      userId: payload.userId,
      email: payload.email,
    },
    'JWT authenticated successfully'
  );
}

/**
 * Optional JWT authentication.
 * 
 * Attempts to authenticate but doesn't reject if no token is provided.
 * Useful for endpoints that have both authenticated and public access.
 * 
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function optionalJWT(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const authHeader = request.headers.authorization;

  if (!authHeader) {
    // No token provided, continue without authentication
    return;
  }

  // Token provided, validate it
  await authenticateJWT(request, reply);
}