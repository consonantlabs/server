/**
 * @fileoverview Prisma Type Declarations
 * @module types/fastify
 * 
 * Extends Fastify types to include Prisma client in the request object.
 * This allows type-safe database access throughout all route handlers.
 * 
 * The Prisma client is injected via a Fastify plugin that runs before
 * all routes, ensuring every request has access to the database.
 */

import type { PrismaClient } from '@prisma/client';

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Prisma client instance for database operations.
     * 
     * Available in all route handlers after the Prisma plugin loads.
     * 
     * @example
     * async function handler(request: FastifyRequest) {
     *   const users = await request.prisma.user.findMany();
     *   return { users };
     * }
     */
    prisma: PrismaClient;
    
    /**
     * Authenticated organization ID.
     * 
     * Set by authentication middleware after validating API key.
     * Undefined if request is not authenticated.
     */
    organizationId?: string;
    
    /**
     * Authenticated user ID.
     * 
     * Set by authentication middleware if using user-based auth.
     * Currently optional as we're using API key auth.
     */
    userId?: string;
  }
}