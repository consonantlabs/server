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
     */
    prisma: PrismaClient;

    /**
     * Authenticated organization ID.
     */
    organizationId?: string;

    /**
     * Authenticated user ID.
     */
    userId?: string;

    /**
     * Authenticated API Key ID.
     */
    apiKeyId?: string;
    /**
     * Authenticated User/Service object from Passport.
     */
    user?: any;
  }
}