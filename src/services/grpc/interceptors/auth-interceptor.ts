import * as grpc from '@grpc/grpc-js';
import { logger } from '../../../utils/logger.js';
import { prisma } from '../../db/index.js';
import { timingSafeEqual } from '@/utils/crypto.js';

/**
 * Authentication Interceptor
 * 
 * Validates cluster credentials from gRPC metadata.
 * Metadata keys: "cluster-id", "cluster-token"
 * 
 * Authentication Flow:
 * 1. Extract cluster-id and cluster-token from metadata
 * 2. Query database for cluster with matching ID
 * 3. Compare provided token with stored token (secure hash comparison)
 * 4. Allow or deny based on validation result
 */
export const authInterceptor: grpc.Interceptor = (
  options: grpc.InterceptorOptions,
  nextCall: (options: grpc.InterceptorOptions) => grpc.InterceptingCall
) => {
  return new grpc.InterceptingCall(nextCall(options), {
    start: (metadata, listener, next) => {
      // Extract credentials from metadata
      const clusterId = metadata.get('cluster-id')[0] as string | undefined;
      const clusterToken = metadata.get('cluster-token')[0] as string | undefined;

      if (!clusterId || !clusterToken) {
        logger.warn( {
          hasClusterId: !!clusterId,
          hasClusterToken: !!clusterToken
        }, '[AuthInterceptor] Missing credentials');
        
        const error: grpc.ServiceError = {
          name: 'UNAUTHENTICATED',
          message: 'Missing cluster credentials',
          code: grpc.status.UNAUTHENTICATED,
          details: 'Provide cluster-id and cluster-token in metadata'
        };
        
        listener.onReceiveStatus(error);
        return;
      }

      // Validate credentials against database
      prisma.cluster.findUnique({
        where: { id: clusterId },
        select: { id: true, tokenHash: true, status: true }
      })
      .then(cluster => {
        if (!cluster) {
          logger.warn( { clusterId }, '[AuthInterceptor] Cluster not found');
          
          const error: grpc.ServiceError = {
            name: 'UNAUTHENTICATED',
            message: 'Invalid cluster ID',
            code: grpc.status.UNAUTHENTICATED,
            details: `Cluster ${clusterId} not found`
          };
          
          listener.onReceiveStatus(error);
          return;
        }

        // Secure token comparison (constant-time to prevent timing attacks)
        const tokenMatches = timingSafeEqual(
          cluster.tokenHash,
          clusterToken
        );

        if (!tokenMatches) {
          logger.warn('[AuthInterceptor] Invalid token', { clusterId });
          
          const error: grpc.ServiceError = {
            name: 'UNAUTHENTICATED',
            message: 'Invalid cluster token',
            code: grpc.status.UNAUTHENTICATED,
            details: 'Provided token does not match'
          };
          
          listener.onReceiveStatus(error);
          return;
        }

        logger.info( {
          clusterId,
          status: cluster.status
        },'[AuthInterceptor] Authentication successful');

        // Authentication successful - proceed with call
        next(metadata, listener);
      })
      .catch(error => {
        logger.error({
          error,
          clusterId
        }, '[AuthInterceptor] Database error');
        
        const grpcError: grpc.ServiceError = {
          name: 'INTERNAL',
          message: 'Authentication system error',
          code: grpc.status.INTERNAL,
          details: error instanceof Error ? error.message : 'Unknown error'
        };
        
        listener.onReceiveStatus(grpcError);
      });
    }
  });
};

