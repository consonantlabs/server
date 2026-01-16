import * as grpc from '@grpc/grpc-js';
import { logger } from '../../../utils/logger.js';

export const loggingInterceptor: grpc.Interceptor = (
  options: grpc.InterceptorOptions,
  nextCall: (options: grpc.InterceptorOptions) => grpc.InterceptingCall
) => {
 
  return new grpc.InterceptingCall(nextCall(options), {
    start: (metadata, listener, next) => {
         const startTime = Date.now();
     const clusterId = metadata?.get('cluster-id')[0] as string || 'unknown';
      next(metadata, {
        ...listener,
        onReceiveStatus: (status, next) => {
          const duration = Date.now() - startTime;
          
          logger.info({
            method: options.method_definition.path,
            clusterId,
            status: status.code,
            durationMs: duration
          }, '[gRPC] Request completed');
          
          next(status);
        }
      });
    }
  });
};