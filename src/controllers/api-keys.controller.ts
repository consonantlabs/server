/**
 * @fileoverview API Key Controller
 * @module controllers/api-keys
 * 
 * Handles API key management operations:
 * - Create new API keys
 * - List organization's API keys
 * - Rotate existing keys
 * - Revoke/delete keys
 * 
 * SECURITY:
 * - API keys are generated with crypto.randomBytes (high entropy)
 * - Keys are hashed with bcrypt before storage (never plaintext)
 * - Only key hash is returned on creation (one-time view)
 * - Key rotation generates new key and invalidates old one
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import { generateSecureToken, hashSecret } from '@/utils/crypto.js';
import { SECURITY } from '@/config/constants.js';
import { logger } from '@/utils/logger.js';
import { sendEvent } from '@/services/inngest/client.js';
import { EVENT_TYPES, RATE_LIMITS } from '@/config/constants.js';

/**
 * Request body for creating an API key.
 */
interface CreateApiKeyBody {
  name: string;
  expiresAt?: string; // ISO date string
  rateLimit?: number; // Requests per minute
}

/**
 * URL parameters for API key routes.
 */
interface ApiKeyParams {
  organizationId: string;
  keyId?: string;
}

/**
 * Create a new API key for an organization.
 * 
 * POST /api/v1/organizations/:organizationId/api-keys
 * 
 * FLOW:
 * 1. Validate request body
 * 2. Generate secure random API key
 * 3. Hash the key with bcrypt
 * 4. Store hash in database
 * 5. Return plaintext key (ONLY TIME IT'S SHOWN)
 * 6. Emit api-key-created event
 * 
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function createApiKey(
  request: FastifyRequest<{
    Params: ApiKeyParams;
    Body: CreateApiKeyBody;
  }>,
  reply: FastifyReply
): Promise<void> {
  const { organizationId } = request.params;
  const { name, expiresAt, rateLimit } = request.body;

  logger.info(
    {
      organizationId,
      name,
    },
    'Creating API key'
  );

  try {
    // Validate organization exists
    const organization = await request.prisma.organization.findUnique({
      where: { id: organizationId },
    });

    if (!organization) {
      reply.code(404).send({
        success: false,
        error: 'Organization not found',
      });
      return;
    }

    // Generate secure API key
    const apiKey = generateSecureToken(SECURITY.MIN_API_KEY_LENGTH);
    logger.debug('Generated API key');

    // Hash the key for storage
    const keyHash = await hashSecret(apiKey);
    logger.debug('Hashed API key');

    // Store in database
    const apiKeyRecord = await request.prisma.apiKey.create({
      data: {
        organizationId,
        name,
        keyHash,
        keyPrefix: apiKey.substring(0, 8),
        expiresAt: expiresAt ? new Date(expiresAt) : null,
        rateLimit: rateLimit || RATE_LIMITS.API_KEY_DEFAULT,
      },
    });

    logger.info(
      {
        keyId: apiKeyRecord.id,
        organizationId,
      },
      'API key created successfully'
    );

    // Emit event for tracking/notifications
    await sendEvent({
      name: EVENT_TYPES.API_KEY_CREATED,
      data: {
        organizationId,
        keyId: apiKeyRecord.id,
        name,
        timestamp: new Date().toISOString(),
      },
    });

    // Return the plaintext key (ONLY TIME IT'S SHOWN)
    reply.code(201).send({
      success: true,
      data: {
        id: apiKeyRecord.id,
        name: apiKeyRecord.name,
        key: apiKey, // ⚠️ PLAINTEXT - show only once
        expiresAt: apiKeyRecord.expiresAt?.toISOString() || null,
        createdAt: apiKeyRecord.createdAt.toISOString(),
      },
      message: 'API key created. Save this key securely - it will not be shown again.',
    });
  } catch (error) {
    logger.error(
      {
        err: error,
        organizationId,
      },
      'Failed to create API key'
    );

    reply.code(500).send({
      success: false,
      error: 'Failed to create API key',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * List all API keys for an organization.
 * 
 * GET /api/v1/organizations/:organizationId/api-keys
 * 
 * Returns metadata only (no key values).
 * 
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function listApiKeys(
  request: FastifyRequest<{ Params: ApiKeyParams }>,
  reply: FastifyReply
): Promise<void> {
  const { organizationId } = request.params;

  logger.debug(
    {
      organizationId,
    },
    'Listing API keys'
  );

  try {
    const apiKeys = await request.prisma.apiKey.findMany({
      where: {
        organizationId,
        revokedAt: null, // Only show active keys
      },
      select: {
        id: true,
        name: true,
        lastUsedAt: true,
        expiresAt: true,
        rateLimit: true,
        rateLimitUsed: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    reply.send({
      success: true,
      data: apiKeys.map(key => ({
        ...key,
        lastUsedAt: key.lastUsedAt?.toISOString() || null,
        expiresAt: key.expiresAt?.toISOString() || null,
        createdAt: key.createdAt.toISOString(),
        updatedAt: key.updatedAt.toISOString(),
      })),
      meta: {
        total: apiKeys.length,
      },
    });
  } catch (error) {
    logger.error(
      {
        err: error,
        organizationId,
      },
      'Failed to list API keys'
    );

    reply.code(500).send({
      success: false,
      error: 'Failed to list API keys',
    });
  }
}

/**
 * Rotate an API key.
 * 
 * POST /api/v1/organizations/:organizationId/api-keys/:keyId/rotate
 * 
 * FLOW:
 * 1. Verify key exists and belongs to organization
 * 2. Generate new secure key
 * 3. Hash new key
 * 4. Update database with new hash
 * 5. Return new plaintext key
 * 6. Emit rotation event
 * 
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function rotateApiKey(
  request: FastifyRequest<{ Params: ApiKeyParams }>,
  reply: FastifyReply
): Promise<void> {
  const { organizationId, keyId } = request.params;

  logger.info(
    {
      organizationId,
      keyId,
    },
    'Rotating API key'
  );

  try {
    // Verify key exists
    const existingKey = await request.prisma.apiKey.findFirst({
      where: {
        id: keyId,
        organizationId,
        revokedAt: null,
      },
    });

    if (!existingKey) {
      reply.code(404).send({
        success: false,
        error: 'API key not found',
      });
      return;
    }

    // Generate new key
    const newApiKey = generateSecureToken(SECURITY.MIN_API_KEY_LENGTH);
    const newKeyHash = await hashSecret(newApiKey);

    // Update database
    const updatedKey = await request.prisma.apiKey.update({
      where: { id: keyId },
      data: {
        keyHash: newKeyHash,
        updatedAt: new Date(),
      },
    });

    logger.info(
      {
        keyId,
        organizationId,
      },
      'API key rotated successfully'
    );

    // Emit rotation event
    await sendEvent({
      name: EVENT_TYPES.API_KEY_ROTATED,
      data: {
        organizationId,
        keyId,
        timestamp: new Date().toISOString(),
      },
    });

    reply.send({
      success: true,
      data: {
        id: updatedKey.id,
        name: updatedKey.name,
        key: newApiKey, // ⚠️ PLAINTEXT - show only once
        expiresAt: updatedKey.expiresAt?.toISOString() || null,
        updatedAt: updatedKey.updatedAt.toISOString(),
      },
      message: 'API key rotated. Save this key securely - it will not be shown again.',
    });
  } catch (error) {
    logger.error(
      {
        err: error,
        organizationId,
        keyId,
      },
      'Failed to rotate API key'
    );

    reply.code(500).send({
      success: false,
      error: 'Failed to rotate API key',
    });
  }
}

/**
 * Revoke/delete an API key.
 * 
 * DELETE /api/v1/organizations/:organizationId/api-keys/:keyId
 * 
 * Soft delete: sets revokedAt timestamp instead of hard delete.
 * This maintains audit trail.
 * 
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function revokeApiKey(
  request: FastifyRequest<{ Params: ApiKeyParams }>,
  reply: FastifyReply
): Promise<void> {
  const { organizationId, keyId } = request.params;

  logger.info(
    {
      organizationId,
      keyId,
    },
    'Revoking API key'
  );

  try {
    // Verify key exists
    const existingKey = await request.prisma.apiKey.findFirst({
      where: {
        id: keyId,
        organizationId,
        revokedAt: null,
      },
    });

    if (!existingKey) {
      reply.code(404).send({
        success: false,
        error: 'API key not found',
      });
      return;
    }

    // Soft delete: set revokedAt
    await request.prisma.apiKey.update({
      where: { id: keyId },
      data: {
        revokedAt: new Date(),
      },
    });

    logger.info(
      {
        keyId,
        organizationId,
      },
      'API key revoked successfully'
    );

    // Emit revocation event
    await sendEvent({
      name: EVENT_TYPES.API_KEY_REVOKED,
      data: {
        organizationId,
        keyId,
        timestamp: new Date().toISOString(),
      },
    });

    reply.send({
      success: true,
      message: 'API key revoked successfully',
    });
  } catch (error) {
    logger.error(
      {
        err: error,
        organizationId,
        keyId,
      },
      'Failed to revoke API key'
    );

    reply.code(500).send({
      success: false,
      error: 'Failed to revoke API key',
    });
  }
}