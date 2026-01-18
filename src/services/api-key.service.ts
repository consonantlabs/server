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

        // Generate a secure 32-byte token (64 hex chars)
        const apiKey = generateSecureToken(32);

        // Extract prefix for O(1) lookups in middleware
        const keyPrefix = apiKey.substring(0, 8);

        // Hash the key for secure storage
        const keyHash = await hashSecret(apiKey);

        try {
            const record = await this.prisma.apiKey.create({
                data: {
                    organizationId,
                    name,
                    keyHash,
                    keyPrefix,
                    expiresAt,
                    rateLimit: rateLimit ?? 100,
                },
            });

            logger.info({
                organizationId,
                keyId: record.id,
                name,
            }, 'API key created');

            return { apiKey, record };
        } catch (error) {
            logger.error({ error, organizationId, name }, 'Failed to create API key');
            throw new Error(`Failed to create API key: ${error}`);
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
            await this.prisma.apiKey.updateMany({
                where: {
                    id: keyId,
                    organizationId,
                },
                data: {
                    revokedAt: new Date(),
                },
            });

            logger.info({ organizationId, keyId }, 'API key revoked');
        } catch (error) {
            logger.error({ error, organizationId, keyId }, 'Failed to revoke API key');
            throw new Error(`Failed to revoke API key: ${error}`);
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
                where: { id: oldKeyId, organizationId }
            });

            if (!oldKey) throw new Error('Old API key not found');

            // 1. Create new key
            const { apiKey, record } = await this.createApiKey({
                organizationId,
                name: `${oldKey.name} (Rotated)`,
                expiresAt: oldKey.expiresAt ?? undefined,
                rateLimit: oldKey.rateLimit,
            });

            // 2. Revoke old key
            await this.revokeApiKey(organizationId, oldKeyId);

            // 3. Update all clusters linked to this key
            await this.prisma.cluster.updateMany({
                where: { apiKeyId: oldKeyId },
                data: { apiKeyId: record.id }
            });

            // 4. Notify connected clusters to refresh config
            const clusters = await this.prisma.cluster.findMany({
                where: { apiKeyId: record.id },
                select: { id: true }
            });

            const { getConnectionManager } = await import('./grpc/connection-manager.js');
            const manager = getConnectionManager();

            for (const cluster of clusters) {
                // sendToCluster will propagate via Redis PubSub if not connected to this pod
                await manager.sendToCluster(cluster.id, {
                    config_update: {
                        cluster_id: cluster.id,
                        config_json: JSON.stringify({
                            api_key: apiKey, // Relayer will use this on next connect
                            rotated_at: new Date().toISOString()
                        })
                    }
                });
            }

            logger.info({ organizationId, oldKeyId, newKeyId: record.id }, 'API key rotated and clusters notified');
            return { apiKey, record };
        } catch (error) {
            logger.error({ error, organizationId, oldKeyId }, 'Failed to rotate API key');
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
