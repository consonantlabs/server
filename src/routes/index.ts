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
import { authenticateApiKey } from '@/middleware/auth.middleware.js';
import { authenticateJWT } from '@/middleware/jwt-auth.middleware.js';
import { authRoutes } from './auth.route.js';
import { organizationRoutes } from './organizations.route.js';
import { dashboardRoutes } from './dashboard.route.js';
import { apiKeyRoutes } from './api-keys.route.js';
import { clusterRoutes } from './clusters.route.js';
import { telemetryRoutes } from './telemetry.route.js';
import { registerApiRoutes } from './sdk.js';

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
      orgScope.addHook('preHandler', authenticateJWT);

      await orgScope.register(organizationRoutes);
      await orgScope.register(dashboardRoutes);
    });

    // ========================================================================
    // Resource Management Routes (API Key Protected)
    // ========================================================================
    // These routes require API key authentication
    // API keys are scoped to organizations and used for programmatic access
    await apiV1.register(async (resourceScope) => {
      // Apply API key authentication to all resource routes
      resourceScope.addHook('preHandler', authenticateApiKey);

      await resourceScope.register(apiKeyRoutes);
      await resourceScope.register(clusterRoutes);
      await resourceScope.register(telemetryRoutes);
    });

    apiV1.log.info('✓ API v1 routes registered');
  }, { prefix: '/api/v1' });

  // ========================================================================
  // SDK Routes (Top-level /api prefix)
  // ========================================================================
  await app.register(async (sdkScope) => {
    // Apply API key authentication
    sdkScope.addHook('preHandler', authenticateApiKey);

    await sdkScope.register(registerApiRoutes);
  });

  app.log.info('✓ All routes registered');
}