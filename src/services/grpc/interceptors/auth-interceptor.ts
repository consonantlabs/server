import * as grpc from '@grpc/grpc-js';
import { logger } from '../../../utils/logger.js';
import { prismaManager } from '../../db/manager.js';
import { verifySecret } from '@/utils/crypto.js';

/**
 * Authentication Interceptor
 * 
 * Validates cluster credentials from gRPC metadata.
 * Metadata keys: "cluster-id", and "api-keys" 
 * 
 * Authentication Flow:
 * 1. Extract cluster-id and api-key from metadata
 * 2. Query database for cluster with matching ID
 * 3. Compare provided api-key with stored api-key (secure hash comparison)
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
        // CASE 1: Registration Flow (API Key)
        if (isRegistering) {
          const keyPrefix = apiKey!.substring(3, 11);
          const apiKeys = await prisma.apiKey.findMany({
            where: { keyPrefix, revokedAt: null }
          });

          for (const key of apiKeys) {
            if (await verifySecret(apiKey!, key.keyHash)) {
              return { type: 'registration', organizationId: key.organizationId };
            }
          }
          throw new Error('Invalid API Key');
        }

        // CASE 2: Operational Flow (Cluster Secret)
        const clusterSecret = metadata.get('x-cluster-secret')[0] as string | undefined;
        if (!clusterSecret || !clusterId) {
          throw new Error('Missing cluster-id or x-cluster-secret');
        }

        const cluster = await prisma.cluster.findUnique({
          where: { id: clusterId },
          select: { secretHash: true, organizationId: true }
        });

        if (!cluster || !cluster.secretHash) {
          throw new Error('Cluster not found or not initialized with secret');
        }

        if (await verifySecret(clusterSecret, cluster.secretHash)) {
          return { type: 'stream', organizationId: cluster.organizationId };
        }

        throw new Error('Invalid Cluster Secret');
      })
        .then((auth) => {
          logger.info({
            methodPath,
            clusterId,
            type: auth.type
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
