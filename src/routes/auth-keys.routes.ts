/**
 * @fileoverview API Key Routes
 * @module routes/api-keys
 */

import type { FastifyInstance } from 'fastify';
import {
    createApiKey,
    listApiKeys,
    rotateApiKey,
    revokeApiKey
} from '../controllers/api-keys.controller.js';

/**
 * Register API key routes.
 * 
 * @param app - Fastify instance
 */
export async function apiKeyRoutes(app: FastifyInstance) {
    // All routes are prefixed with /api/v1/organizations/:organizationId via index.ts

    // List API keys
    app.get('/', listApiKeys);

    // Create API key
    app.post('/', createApiKey);

    // Rotate API key
    app.post('/:keyId/rotate', rotateApiKey);

    // Revoke API key
    app.delete('/:keyId', revokeApiKey);
}
