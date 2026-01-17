import * as grpc from '@grpc/grpc-js';
import { logger } from '../../../utils/logger.js';

export const errorInterceptor: grpc.Interceptor = ((
  options: grpc.InterceptorOptions,
  nextCall: (options: grpc.InterceptorOptions) => grpc.InterceptingCall
) => {
  return new grpc.InterceptingCall(nextCall(options), {
    start: (metadata, listener, next) => {
      next(metadata, {
        ...listener,
        onReceiveStatus: (status, next) => {
          if (status.code !== grpc.status.OK) {
            logger.error({
              method: options.method_definition.path,
              code: status.code,
              message: status.details
            }, '[gRPC] Error response');
          }
          next(status);
        }
      });
    }
  });
}) as any;