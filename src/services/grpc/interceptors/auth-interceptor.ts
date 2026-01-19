import * as grpc from '@grpc/grpc-js';
import { logger } from '../../../utils/logger.js';
import { prismaManager } from '../../db/manager.js';
import { verifySecret } from '@/utils/crypto.js';

/**
 * Authentication Interceptor
 * 
 * Validates cluster credentials from gRPC metadata.
 * Metadata keys: "cluster-id", "cluster-token", we use api-keys for now
 * 
 * Authentication Flow:
 * 1. Extract cluster-id and cluster-token from metadata
 * 2. Query database for cluster with matching ID
 * 3. Compare provided token with stored token (secure hash comparison)
 * 4. Allow or deny based on validation result
 */
export const authInterceptor: grpc.Interceptor = ((options: any, nextCall: any) => {
  return new grpc.InterceptingCall(nextCall(options), {
    start: (metadata, listener, next) => {
      const methodPath = options.method_definition.path;
      const isRegistering = methodPath.includes('RegisterCluster');

      // Extract credentials from metadata
      const apiKey = metadata.get('x-api-key')[0] as string | undefined;
      const clusterId = metadata.get('cluster-id')[0] as string | undefined;

      if (!apiKey || (!isRegistering && !clusterId)) {
        logger.warn({
          methodPath,
          hasApiKey: !!apiKey,
          hasClusterId: !!clusterId
        }, '[AuthInterceptor] Missing credentials');

        const error: grpc.ServiceError = {
          name: 'UNAUTHENTICATED',
          message: 'Missing credentials',
          code: grpc.status.UNAUTHENTICATED,
          details: isRegistering ? 'Provide x-api-key in metadata' : 'Provide x-api-key and cluster-id in metadata',
          metadata: new grpc.Metadata()
        };

        listener.onReceiveStatus(error);
        return;
      }

      // Validate credentials against database
      prismaManager.getClient().then(async (prisma) => {
        // 1. Authenticate API Key first
        const keyPrefix = apiKey.substring(0, 8);
        const apiKeys = await prisma.apiKey.findMany({
          where: { keyPrefix, revokedAt: null }
        });

        let validKey = null;
        for (const key of apiKeys) {
          if (await verifySecret(apiKey, key.keyHash)) {
            validKey = key;
            break;
          }
        }

        if (!validKey) {
          throw new Error('Invalid API Key');
        }

        // 2. For non-registration calls, ensure cluster exists and belongs to organization
        if (!isRegistering) {
          const cluster = await prisma.cluster.findFirst({
            where: { id: clusterId, organizationId: validKey.organizationId },
            select: { id: true, secretHash: true, status: true }
          });

          if (!cluster) {
            throw new Error(`Cluster ${clusterId} not found or access denied`);
          }
        }

        return { validKey };
      })
        .then(() => {
          logger.info({
            methodPath,
            clusterId
          }, '[AuthInterceptor] Authentication successful');

          // Authentication successful - proceed with call
          next(metadata, listener);
        })
        .catch((error: any) => {
          logger.warn({
            methodPath,
            error: error.message,
            clusterId
          }, '[AuthInterceptor] Auth failed');

          const grpcError: grpc.ServiceError = {
            name: 'UNAUTHENTICATED',
            message: 'Authentication failed',
            code: grpc.status.UNAUTHENTICATED,
            details: error.message,
            metadata: new grpc.Metadata()
          };

          listener.onReceiveStatus(grpcError);
        });
    }
  });
});
