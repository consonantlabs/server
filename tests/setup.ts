import { beforeAll, afterAll } from 'vitest';
import { prismaManager } from '../src/services/db/manager.js';
import { redisClient } from '../src/services/redis/client.ts';
import { logger } from '../src/utils/logger.js';

// Disable logging during tests to keep output clean
logger.level = 'silent';

beforeAll(async () => {
    // Ensure we are in test mode
    if (process.env.NODE_ENV !== 'test') {
        process.env.NODE_ENV = 'test';
    }

    // Initialize DB and Redis if they are not already connected
    // This helps if tests are run in a way that doesn't start the full server
    try {
        await prismaManager.initialize(logger);
        await redisClient.connect();
    } catch (err) {
        console.warn('⚠️  Could not connect to DB or Redis. Integration tests might fail if they require real infrastructure.');
    }
});

afterAll(async () => {
    // Graceful disconnect
    await prismaManager.disconnect();
    await redisClient.disconnect();
});
