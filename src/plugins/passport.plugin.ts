import fp from 'fastify-plugin';
import { Authenticator } from '@fastify/passport';
const passport = new Authenticator();
export { passport };

import { Strategy as JwtStrategy, ExtractJwt } from 'passport-jwt';
import { HeaderAPIKeyStrategy } from 'passport-headerapikey';
import { env } from '../config/env.js';
import { prismaManager } from '../services/db/manager.js';
import { verifySecret } from '../utils/crypto.js';
import { logger } from '../utils/logger.js';

/**
 * Passport.js Plugin
 * 
 * Provides unified, extensible authentication for:
 * 1. User Sessions (JWT) - For human operators and dashboard access.
 * 2. Service/SDK Access (API Key) - For machine-to-machine high-scale execution.
 */
export default fp(async (fastify) => {
    // 1. Initialize Passport
    await fastify.register(passport.initialize());
    await fastify.register(passport.secureSession());

    // ===========================================================================
    // STRATEGY 1: USER AUTH (JWT)
    // ===========================================================================
    passport.use('jwt', new JwtStrategy({
        jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
        secretOrKey: env.JWT_SECRET,
    }, async (payload, done) => {
        try {
            const prisma = await prismaManager.getClient();
            const user = await prisma.user.findUnique({
                where: { id: payload.userId },
                select: { id: true, email: true, organizations: true }
            });

            if (!user) return done(null, false);
            return done(null, user);
        } catch (err) {
            return done(err, false);
        }
    }));

    // ===========================================================================
    // STRATEGY 2: SERVICE AUTH (API KEY)
    // ===========================================================================
    passport.use('api-key', new HeaderAPIKeyStrategy(
        { header: 'X-API-Key', prefix: '' },
        false,
        async (apiKey, done) => {
            try {
                const prisma = await prismaManager.getClient();
                const keyPrefix = apiKey.substring(0, 8);

                // Find candidate keys (Prefix lookup is indexed and lightning fast)
                const apiKeys = await prisma.apiKey.findMany({
                    where: {
                        keyPrefix,
                        revokedAt: null,
                        OR: [
                            { expiresAt: null },
                            { expiresAt: { gt: new Date() } }
                        ],
                    },
                    select: { id: true, keyHash: true, organizationId: true }
                });

                // Timing-safe secret verification
                for (const key of apiKeys) {
                    if (await verifySecret(apiKey, key.keyHash)) {
                        return done(null, {
                            id: key.id,
                            organizationId: key.organizationId,
                            type: 'service_key'
                        });
                    }
                }

                return done(null, false);
            } catch (err) {
                logger.error({ err }, 'Passport API Key verification failed');
                return done(err as Error);
            }
        }
    ));

    // User Serialization (Minimal as we are stateless JWT/ApiKey based)
    passport.registerUserSerializer(async (user: any) => user.id);
    passport.registerUserDeserializer(async (id: string) => {
        const prisma = await prismaManager.getClient();
        return await prisma.user.findUnique({ where: { id } });
    });

    logger.info('✓ Passport.js plugin initialized');
});
