/**
 * @fileoverview API Key Service
 * @module services/api-keys
 * 
 * Manages the lifecycle of API keys, including generation, revocation,
 * and rotation.
 */

import { PrismaClient, ApiKey } from '@prisma/client';
import { generateSecureToken, hashSecret } from '../utils/crypto.js';
import { logger } from '../utils/logger.js';
import { sendEvent } from './inngest/client.js';
import { EVENT_TYPES, RATE_LIMITS } from '@/config/constants.js';

export interface CreateApiKeyOptions {
    organizationId: string;
    name: string;
    expiresAt?: Date;
    rateLimit?: number;
}

export class ApiKeyService {
    constructor(private prisma: PrismaClient) { }

    /**
     * Create a new API key for an organization.
     * 
     * Generates a secure random token, hashes it, and stores the hash
     * along with a prefix for efficient lookup.
     * 
     * @param options - API key configuration
     * @returns The plaintext API key and the created database record
     */
    async createApiKey(options: CreateApiKeyOptions): Promise<{ apiKey: string; record: ApiKey }> {
        const { organizationId, name, expiresAt, rateLimit } = options;

        try {
            // 1. Validate organization exists
            const organization = await this.prisma.organization.findUnique({
                where: { id: organizationId },
            });

            if (!organization) {
                throw new Error('Organization not found');
            }

            // 2. Generate a secure token with consistent prefix
            const rawToken = generateSecureToken(32);
            const apiKey = `sk_${rawToken}`;
            const keyPrefix = apiKey.substring(3, 11);

            // 3. Hash the key for secure storage
            const keyHash = await hashSecret(apiKey);

            // 4. Ensure global uniqueness of the key hash
            const existing = await this.prisma.apiKey.findFirst({
                where: { keyHash }
            });

            if (existing) {
                logger.error({ keyPrefix }, 'API key collision detected - retrying');
                return this.createApiKey(options);
            }

            // 5. Store in database
            const record = await this.prisma.apiKey.create({
                data: {
                    organizationId,
                    name,
                    keyHash,
                    keyPrefix,
                    expiresAt,
                    rateLimit: rateLimit ?? RATE_LIMITS.API_KEY_DEFAULT,
                },
            });

            // 6. Emit event for tracking
            await sendEvent({
                name: EVENT_TYPES.API_KEY_CREATED,
                data: {
                    organizationId,
                    keyId: record.id,
                    name,
                    timestamp: new Date().toISOString(),
                },
            });

            logger.info({
                organizationId,
                keyId: record.id,
                name,
                keyPrefix,
            }, 'API key created');

            return { apiKey, record };
        } catch (error) {
            logger.error({ error, organizationId, name }, 'Failed to create API key');
            throw error;
        }
    }

    /**
     * List all API keys for an organization.
     */
    async listApiKeys(organizationId: string): Promise<ApiKey[]> {
        return this.prisma.apiKey.findMany({
            where: { organizationId },
            orderBy: { createdAt: 'desc' },
        });
    }

    /**
     * Revoke an API key.
     * 
     * Permanently disables an API key by setting revokedAt.
     */
    async revokeApiKey(organizationId: string, keyId: string): Promise<void> {
        try {
            const result = await this.prisma.apiKey.updateMany({
                where: {
                    id: keyId,
                    organizationId,
                    revokedAt: null,
                },
                data: {
                    revokedAt: new Date(),
                },
            });

            if (result.count === 0) {
                throw new Error('API key not found or already revoked');
            }

            // Emit revocation event
            await sendEvent({
                name: EVENT_TYPES.API_KEY_REVOKED,
                data: {
                    organizationId,
                    keyId,
                    timestamp: new Date().toISOString(),
                },
            });

            logger.info({ organizationId, keyId }, 'API key revoked');
        } catch (error) {
            logger.error({ error, organizationId, keyId }, 'Failed to revoke API key');
            throw error;
        }
    }

    /**
     * Delete an API key permanently.
     */
    async deleteApiKey(organizationId: string, keyId: string): Promise<void> {
        try {
            await this.prisma.apiKey.deleteMany({
                where: {
                    id: keyId,
                    organizationId,
                },
            });

            logger.info({ organizationId, keyId }, 'API key deleted');
        } catch (error) {
            logger.error({ error, organizationId, keyId }, 'Failed to delete API key');
            throw new Error(`Failed to delete API key: ${error}`);
        }
    }
    /**
     * Rotate an API key.
     * 
     * Creates a new key, copies settings, revokes the old one,
     * and returns the new plaintext key.
     */
    async rotateApiKey(organizationId: string, oldKeyId: string): Promise<{ apiKey: string; record: ApiKey }> {
        try {
            const oldKey = await this.prisma.apiKey.findUnique({
                where: { id: oldKeyId, organizationId, revokedAt: null }
            });

            if (!oldKey) throw new Error('API key not found or revoked');

            // 1. Create new key
            const { apiKey, record } = await this.createApiKey({
                organizationId,
                name: `${oldKey.name} (Rotated)`,
                expiresAt: oldKey.expiresAt ?? undefined,
                rateLimit: oldKey.rateLimit,
            });

            // 2. Revoke old key (manually set revokedAt to avoid double event if we wanted, but here we just call the logic)
            await this.prisma.apiKey.update({
                where: { id: oldKeyId },
                data: { revokedAt: new Date() }
            });

            // 3. Emit rotation event
            await sendEvent({
                name: EVENT_TYPES.API_KEY_ROTATED,
                data: {
                    organizationId,
                    keyId: oldKeyId,
                    timestamp: new Date().toISOString(),
                },
            });

            // 4. Update all clusters linked to this key
            await this.prisma.cluster.updateMany({
                where: { apiKeyId: oldKeyId },
                data: { apiKeyId: record.id }
            });

            // 5. Notify connected clusters to refresh config
            const clusters = await this.prisma.cluster.findMany({
                where: { apiKeyId: record.id },
                select: { id: true }
            });

            const { getConnectionManager } = await import('./grpc/connection-manager.js');
            const manager = getConnectionManager();

            for (const cluster of clusters) {
                await manager.sendToCluster(cluster.id, {
                    config_update: {
                        cluster_id: cluster.id,
                        config_json: JSON.stringify({
                            api_key: apiKey,
                            rotated_at: new Date().toISOString()
                        })
                    }
                });
            }

            logger.info({ organizationId, oldKeyId, newKeyId: record.id }, 'API key rotated successfully');
            return { apiKey, record };
        } catch (error) {
            logger.error({ error, organizationId, oldKeyOld: oldKeyId }, 'Failed to rotate API key');
            throw error;
        }
    }
}

let apiKeyServiceInstance: ApiKeyService | null = null;

export function initApiKeyService(prisma: PrismaClient): void {
    apiKeyServiceInstance = new ApiKeyService(prisma);
}

export function getApiKeyService(): ApiKeyService {
    if (!apiKeyServiceInstance) {
        throw new Error('ApiKeyService not initialized');
    }
    return apiKeyServiceInstance;
}
