/**
 * @fileoverview API Key Service
 * @module services/api-keys
 * 
 * Manages the lifecycle of API keys, including generation, revocation,
 * and rotation.
 */

import { PrismaClient, ApiKey } from '@prisma/client';
import { generateSecureToken, hashSecret } from '../../utils/crypto.js';
import { logger } from '../../utils/logger.js';

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
