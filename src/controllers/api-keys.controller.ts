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
import { logger } from '@/utils/logger.js';
import { getApiKeyService } from '@/services/api-key.service.js';

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
    const service = getApiKeyService();
    const { apiKey, record } = await service.createApiKey({
      organizationId,
      name,
      expiresAt: expiresAt ? new Date(expiresAt) : undefined,
      rateLimit,
    });

    reply.code(201).send({
      success: true,
      data: {
        id: record.id,
        name: record.name,
        key: apiKey,
        expiresAt: record.expiresAt?.toISOString() || null,
        createdAt: record.createdAt.toISOString(),
      },
      message: 'API key created. Save this key securely - it will not be shown again.',
    });
  } catch (error: any) {
    const statusCode = error.message === 'Organization not found' ? 404 : 500;
    reply.code(statusCode).send({
      success: false,
      error: error.message || 'Failed to create API key',
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
    const service = getApiKeyService();
    const apiKeys = await service.listApiKeys(organizationId);

    reply.send({
      success: true,
      data: apiKeys.map(key => ({
        id: key.id,
        name: key.name,
        lastUsedAt: key.lastUsedAt?.toISOString() || null,
        expiresAt: key.expiresAt?.toISOString() || null,
        rateLimit: key.rateLimit,
        rateLimitUsed: key.rateLimitUsed,
        createdAt: key.createdAt.toISOString(),
        updatedAt: key.updatedAt.toISOString(),
      })),
      meta: {
        total: apiKeys.length,
      },
    });
  } catch (error) {
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
    const service = getApiKeyService();
    const { apiKey, record } = await service.rotateApiKey(organizationId, keyId!);

    reply.send({
      success: true,
      data: {
        id: record.id,
        name: record.name,
        key: apiKey,
        expiresAt: record.expiresAt?.toISOString() || null,
        updatedAt: record.updatedAt.toISOString(),
      },
      message: 'API key rotated. Save this key securely - it will not be shown again.',
    });
  } catch (error: any) {
    const statusCode = error.message.includes('not found') ? 404 : 500;
    reply.code(statusCode).send({
      success: false,
      error: error.message || 'Failed to rotate API key',
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
    const service = getApiKeyService();
    await service.revokeApiKey(organizationId, keyId!);

    reply.send({
      success: true,
      message: 'API key revoked successfully',
    });
  } catch (error: any) {
    const statusCode = error.message.includes('not found') ? 404 : 500;
    reply.code(statusCode).send({
      success: false,
      error: error.message || 'Failed to revoke API key',
    });
  }
}