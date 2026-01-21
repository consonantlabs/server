/**
 * @fileoverview API Routes Index
 * @module routes
 * 
 * Central registration point for all API routes in the Consonant Control Plane.
 * This module coordinates the registration of functional route blocks and
 * applies centralized authentication hooks.
 * 
 * ARCHITECTURAL DESIGN:
 * We use a nested registration pattern to group routes by responsibility:
 * 1. Base API V1 (/api/v1)
 * 2. Auth Routes (Public & JWT)
 * 3. Authenticated Scope (API Key or JWT required)
 * 4. Organization-Scoped Resources (scoped by :organizationId)
 */

import type { FastifyInstance } from 'fastify';
import { authenticate } from '@/middleware/auth.middleware.js';
import { authRoutes } from './auth.routes.js';
import { apiKeyRoutes } from './api-keys.routes.js';
import { clusterRoutes } from './cluster.routes.js';
import { telemetryRoutes } from './telemetry.routes.js';
import { agentRoutes } from './agents.routes.js';

/**
 * Register all API v1 routes.
 * 
 * @param app - Fastify instance
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.log.info('Registering API routes...');

  // Parent API V1 Scope
  await app.register(async (apiV1) => {

    // 1. Authentication & User Management (JWT or Public)
    await apiV1.register(authRoutes);

    // 2. Authenticated API Routes
    // All routes under this scope require either a valid API Key or JWT.
    await apiV1.register(async (authenticated) => {
      authenticated.addHook('preHandler', authenticate);

      // Organization-Scoped Resources
      // These routes follow the /organizations/:organizationId pattern
      await authenticated.register(async (orgScoped) => {
        await orgScoped.register(apiKeyRoutes, { prefix: '/organizations/:organizationId/api-keys' });
        await orgScoped.register(clusterRoutes, { prefix: '/organizations/:organizationId/clusters' });
        await orgScoped.register(telemetryRoutes, { prefix: '/organizations/:organizationId' });
      });

      // SDK and Internal Direct Endpoints
      // Includes agent registration and execution
      await authenticated.register(agentRoutes);
    });

    app.log.info('✓ All API V1 routes registered');
  });
}