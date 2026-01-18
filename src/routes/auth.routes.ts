/**
 * @fileoverview Authentication Routes
 * @module routes/auth
 * 
 * REST API routes for user authentication and profile management.
 * These are public routes (signup, login) and authenticated routes (profile).
 */

import type { FastifyInstance } from 'fastify';
import {
  signup,
  login,
  getCurrentUser,
  updateProfile,
  changePassword,
} from '@/controllers/auth.controller.js';
import { authenticate } from '@/middleware/auth.middleware.js';

/**
 * Register authentication routes with Fastify.
 * 
 * Public Routes:
 * - POST /auth/signup - Create new account
 * - POST /auth/login - Login with email/password
 * 
 * Authenticated Routes (require JWT):
 * - GET  /auth/me - Get current user profile
 * - PATCH /auth/me - Update profile
 * - POST /auth/change-password - Change password
 * 
 * @param app - Fastify instance
 */
export async function authRoutes(app: FastifyInstance): Promise<void> {
  // Public routes - no authentication required
  app.post('/auth/signup', signup);
  app.post('/auth/login', login);

  // Authenticated routes - require JWT token
  app.get('/auth/me', { preHandler: authenticate }, getCurrentUser as any);
  app.patch('/auth/me', { preHandler: authenticate }, updateProfile as any);
  app.post('/auth/change-password', { preHandler: authenticate }, changePassword as any);
}