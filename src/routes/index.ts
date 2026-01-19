/**
 * @fileoverview API Routes Index
 * @module routes
 * 
 * Central registration point for all API routes.
 * This module imports and registers all route modules with the Fastify instance.
 * 
 * ROUTE ORGANIZATION:
 * - /api/v1/auth/* - User authentication (public + authenticated)
 * - /api/v1/organizations/* - Organization management (authenticated)
 * - /api/v1/organizations/:organizationId/api-keys - API key management
 * - /api/v1/organizations/:organizationId/clusters - Cluster management
 * - /api/v1/organizations/:organizationId/traces - Trace queries
 * - /api/v1/organizations/:organizationId/metrics - Metric queries
 * - /api/v1/organizations/:organizationId/logs - Log queries
 * 
 * AUTHENTICATION:
 * - Auth routes use JWT authentication (Bearer tokens)
 * - Organization/resource routes use API key authentication (X-API-Key header)
 * - Some routes support both methods
 */

import type { FastifyInstance } from 'fastify';
import { authenticate } from '@/middleware/auth.middleware.js';
import { authRoutes } from './auth.routes.js';
// import { organizationRoutes } from './organizations.route.js';
// import { dashboardRoutes } from './dashboard.route.js';
import { apiKeyRoutes } from './api-keys.routes.js';
import { clusterRoutes } from './cluster.routes.js';
import { telemetryRoutes } from './telemetry.routes.js';
import { registerApiRoutes } from './sdk.routes.js';

/**
 * Register all API v1 routes.
 * 
 * This function:
 * 1. Registers authentication routes (public + JWT protected)
 * 2. Registers organization management routes (JWT protected)
 * 3. Registers resource management routes (API key protected)
 * 4. Groups routes under /api/v1 prefix
 * 
 * @param app - Fastify instance
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.log.info('Registering API routes...');

  // Register routes under /api/v1 prefix
  await app.register(async (apiV1) => {

    // ========================================================================
    // Authentication Routes (Public + JWT Protected)
    // ========================================================================
    // These routes handle user signup, login, and profile management
    // Public routes: signup, login
    // Protected routes: profile, password change
    await apiV1.register(authRoutes);

    // ========================================================================
    // Organization Management Routes (JWT Protected)
    // ========================================================================
    // These routes require user authentication via JWT
    // Users manage their organizations and members
    await apiV1.register(async (orgScope) => {
      // Apply JWT authentication to all organization routes
      // Apply authentication (User/JWT preferred for Org Management)
      orgScope.addHook('preHandler', authenticate);

      // await orgScope.register(organizationRoutes);
      // await orgScope.register(dashboardRoutes);
    });

    // ========================================================================
    // Resource Management Routes (API Key Protected)
    // ========================================================================
    // These routes require API key authentication
    // API keys are scoped to organizations and used for programmatic access
    await apiV1.register(async (resourceScope) => {
      // Apply API key authentication to all resource routes
      resourceScope.addHook('preHandler', authenticate);

      // Register routes with organization prefix
      await resourceScope.register(apiKeyRoutes, { prefix: '/organizations/:organizationId/api-keys' });
      await resourceScope.register(clusterRoutes, { prefix: '/organizations/:organizationId/clusters' });
      await resourceScope.register(telemetryRoutes, { prefix: '/organizations/:organizationId' });
    });

    apiV1.log.info('✓ API v1 routes registered');
  }, { prefix: '/api/v1' });

  // ========================================================================
  // SDK Routes (Top-level /api prefix)
  // ========================================================================
  await app.register(async (sdkScope) => {
    // Apply API key authentication
    // Apply authentication
    sdkScope.addHook('preHandler', authenticate);

    await sdkScope.register(registerApiRoutes);
  });

  app.log.info('✓ All routes registered');
}