import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { buildApp } from '../../src/server.js';
import { prismaManager } from '../../src/services/db/manager.js';
import { generateApiKey } from '../../src/utils/crypto.js';
import { FastifyInstance } from 'fastify';

describe('Authentication Integration Tests', () => {
    let app: FastifyInstance;
    let testOrgId: string;
    let testApiKey: string;

    beforeAll(async () => {
        app = await buildApp();
        const prisma = await prismaManager.getClient();

        // Setup test data
        const org = await prisma.organization.create({
            data: {
                name: 'Test Org ' + Date.now(),
                slug: 'test-org-' + Date.now(),
            }
        });
        testOrgId = org.id;

        const keyResult = await generateApiKey();
        testApiKey = keyResult.apiKey;

        await prisma.apiKey.create({
            data: {
                id: crypto.randomUUID(),
                organizationId: testOrgId,
                name: 'Test Key',
                keyPrefix: testApiKey.substring(0, 8),
                keyHash: keyResult.keyHash,
            }
        });
    });

    afterAll(async () => {
        await app.close();
    });

    it('should reject requests without authentication', async () => {
        const response = await request(app.server)
            .get('/api/v1/organizations/' + testOrgId + '/api-keys');

        expect(response.status).toBe(401);
        expect(response.body.success).toBe(false);
    });

    it('should authenticate with a valid API key', async () => {
        // Note: We use the server from fastify instance
        const response = await request(app.server)
            .get('/api/v1/organizations/' + testOrgId + '/api-keys')
            .set('X-API-Key', testApiKey);

        expect(response.status).toBe(200);
        expect(Array.isArray(response.body.data)).toBe(true);
    });

    it('should reject an invalid API key', async () => {
        const response = await request(app.server)
            .get('/api/v1/organizations/' + testOrgId + '/api-keys')
            .set('X-API-Key', 'invalid-key');

        expect(response.status).toBe(401);
    });
});
