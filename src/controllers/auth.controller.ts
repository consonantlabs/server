/**
 * @fileoverview User Authentication Controller
 * @module controllers/auth
 * 
 * Handles user authentication and profile management for the SaaS platform.
 * 
 * AUTHENTICATION FLOW:
 * 1. User signs up with email/password
 * 2. Email verification sent (optional but recommended)
 * 3. User logs in with credentials
 * 4. Server returns JWT token
 * 5. Client includes JWT in Authorization header for subsequent requests
 * 
 * SECURITY:
 * - Passwords hashed with bcrypt (cost factor 12)
 * - JWTs expire after 7 days
 * - Refresh tokens for long-lived sessions
 * - Rate limiting on login attempts
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import { hashSecret, verifySecret, generateSecureToken } from '@/utils/crypto.js';
import { logger } from '@/utils/logger.js';
import { env } from '@/config/env.js';
import jwt from 'jsonwebtoken';

/**
 * JWT payload structure.
 */
interface JWTPayload {
  userId: string;
  email: string;
  iat: number;
  exp: number;
}

/**
 * Request body for user signup.
 */
interface SignupBody {
  email: string;
  password: string;
  name?: string;
}

/**
 * Request body for user login.
 */
interface LoginBody {
  email: string;
  password: string;
}

/**
 * Request body for password change.
 */
interface ChangePasswordBody {
  currentPassword: string;
  newPassword: string;
}

/**
 * Generate JWT token for user.
 * 
 * @param userId - User ID
 * @param email - User email
 * @returns JWT token
 */
function generateToken(userId: string, email: string): string {
  if (!env.JWT_SECRET) {
    throw new Error('JWT_SECRET not configured');
  }

  return jwt.sign(
    {
      userId,
      email,
    },
    env.JWT_SECRET,
    {
      expiresIn: '7d',
    }
  );
}

/**
 * Verify JWT token.
 * 
 * @param token - JWT token
 * @returns Decoded payload or null if invalid
 */
export function verifyToken(token: string): JWTPayload | null {
  if (!env.JWT_SECRET) {
    return null;
  }

  try {
    return jwt.verify(token, env.JWT_SECRET) as JWTPayload;
  } catch {
    return null;
  }
}

/**
 * User signup endpoint.
 * 
 * POST /api/v1/auth/signup
 * 
 * Creates a new user account and returns a JWT token.
 * 
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function signup(
  request: FastifyRequest<{
    Body: SignupBody;
  }>,
  reply: FastifyReply
): Promise<void> {
  const { email, password, name } = request.body;

  logger.info({ email }, 'User signup attempt');

  try {
    // Validate password strength
    if (password.length < 8) {
      reply.code(400).send({
        success: false,
        error: 'Password must be at least 8 characters',
      });
      return;
    }

    // Check if user already exists
    const existingUser = await request.prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      reply.code(409).send({
        success: false,
        error: 'User with this email already exists',
      });
      return;
    }

    // Hash password
    const passwordHash = await hashSecret(password);

    // Create user
    const user = await request.prisma.user.create({
      data: {
        email,
        passwordHash,
        name,
      },
    });

    logger.info({ userId: user.id, email }, 'User created successfully');

    // Generate JWT token
    const token = generateToken(user.id, user.email);

    reply.code(201).send({
      success: true,
      data: {
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          createdAt: user.createdAt.toISOString(),
        },
        token,
      },
      message: 'Account created successfully',
    });
  } catch (error) {
    logger.error({ err: error, email }, 'Failed to create user');

    reply.code(500).send({
      success: false,
      error: 'Failed to create account',
    });
  }
}

/**
 * User login endpoint.
 * 
 * POST /api/v1/auth/login
 * 
 * Authenticates user and returns JWT token.
 * 
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function login(
  request: FastifyRequest<{
    Body: LoginBody;
  }>,
  reply: FastifyReply
): Promise<void> {
  const { email, password } = request.body;

  logger.info({ email }, 'User login attempt');

  try {
    // Find user
    const user = await request.prisma.user.findUnique({
      where: { email },
    });

    if (!user) {
      reply.code(401).send({
        success: false,
        error: 'Invalid email or password',
      });
      return;
    }

    // Verify password
    const isValid = await verifySecret(password, user.passwordHash || '');

    if (!isValid) {
      reply.code(401).send({
        success: false,
        error: 'Invalid email or password',
      });
      return;
    }

    logger.info({ userId: user.id, email }, 'User logged in successfully');

    // Generate JWT token
    const token = generateToken(user.id, user.email);

    reply.send({
      success: true,
      data: {
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          createdAt: user.createdAt.toISOString(),
        },
        token,
      },
    });
  } catch (error) {
    logger.error({ err: error, email }, 'Failed to login user');

    reply.code(500).send({
      success: false,
      error: 'Failed to login',
    });
  }
}

/**
 * Get current user profile.
 * 
 * GET /api/v1/auth/me
 * 
 * Requires authentication.
 * 
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function getCurrentUser(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const userId = request.userId;

  if (!userId) {
    reply.code(401).send({
      success: false,
      error: 'Not authenticated',
    });
    return;
  }

  try {
    const user = await request.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        createdAt: true,
      },
    });

    if (!user) {
      reply.code(404).send({
        success: false,
        error: 'User not found',
      });
      return;
    }

    reply.send({
      success: true,
      data: {
        id: user.id,
        email: user.email,
        name: user.name,
        createdAt: user.createdAt.toISOString(),
      },
    });
  } catch (error) {
    logger.error({ err: error, userId }, 'Failed to get user profile');

    reply.code(500).send({
      success: false,
      error: 'Failed to get profile',
    });
  }
}

/**
 * Update user profile.
 * 
 * PATCH /api/v1/auth/me
 * 
 * Requires authentication.
 * 
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function updateProfile(
  request: FastifyRequest<{
    Body: { name?: string };
  }>,
  reply: FastifyReply
): Promise<void> {
  const userId = request.userId;
  const { name } = request.body;

  if (!userId) {
    reply.code(401).send({
      success: false,
      error: 'Not authenticated',
    });
    return;
  }

  try {
    const user = await request.prisma.user.update({
      where: { id: userId },
      data: { name },
      select: {
        id: true,
        email: true,
        name: true,
        createdAt: true,
      },
    });

    reply.send({
      success: true,
      data: user,
    });
  } catch (error) {
    logger.error({ err: error, userId }, 'Failed to update profile');

    reply.code(500).send({
      success: false,
      error: 'Failed to update profile',
    });
  }
}

/**
 * Change password.
 * 
 * POST /api/v1/auth/change-password
 * 
 * Requires authentication.
 * 
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function changePassword(
  request: FastifyRequest<{
    Body: ChangePasswordBody;
  }>,
  reply: FastifyReply
): Promise<void> {
  const userId = request.userId;
  const { currentPassword, newPassword } = request.body;

  if (!userId) {
    reply.code(401).send({
      success: false,
      error: 'Not authenticated',
    });
    return;
  }

  try {
    // Validate new password
    if (newPassword.length < 8) {
      reply.code(400).send({
        success: false,
        error: 'New password must be at least 8 characters',
      });
      return;
    }

    // Get current user
    const user = await request.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      reply.code(404).send({
        success: false,
        error: 'User not found',
      });
      return;
    }

    // Verify current password
    const isValid = await verifySecret(currentPassword, user.passwordHash || '');

    if (!isValid) {
      reply.code(401).send({
        success: false,
        error: 'Current password is incorrect',
      });
      return;
    }

    // Hash new password
    const newPasswordHash = await hashSecret(newPassword);

    // Update password
    await request.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: newPasswordHash },
    });

    logger.info({ userId }, 'Password changed successfully');

    reply.send({
      success: true,
      message: 'Password changed successfully',
    });
  } catch (error) {
    logger.error({ err: error, userId }, 'Failed to change password');

    reply.code(500).send({
      success: false,
      error: 'Failed to change password',
    });
  }
}