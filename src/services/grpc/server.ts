/**
 * gRPC Server for Consonant Backend
 * 
 * Runs alongside Fastify HTTP server on separate port.
 * Handles bidirectional streaming with relayer agents.
 */

import * as grpc from '@grpc/grpc-js';
import { logger } from '../../utils/logger.js';
// import { ConnectionManager } from './connection-manager.js';
// import { RelayerServiceImpl } from './services/relayer-service.js';
import { authInterceptor } from './interceptors/auth-interceptor.js';
import { loggingInterceptor } from './interceptors/logging-interceptor.js';
import { errorInterceptor } from './interceptors/error-interceptor.js';
import { RelayerServiceService } from '@consonant/proto-relayer';

export interface GrpcServerConfig {
  port: number;
  host: string;
  tlsEnabled: boolean;
  tlsCert?: string;
  tlsKey?: string;
  maxConnectionAge: number;
  maxConnectionIdle: number;
  keepaliveTime: number;
  keepaliveTimeout: number;
}

export class GrpcServer {
  private server: grpc.Server;
  private connectionManager: ConnectionManager;
  private config: GrpcServerConfig;
  private isRunning = false;

  constructor(config: GrpcServerConfig) {
    this.config = config;
    this.connectionManager = new ConnectionManager();
    
    // Create gRPC server with interceptors
    this.server = new grpc.Server({
      // Channel arguments for production-grade streaming
      'grpc.max_concurrent_streams': 100,
      'grpc.max_connection_age_ms': config.maxConnectionAge,
      'grpc.max_connection_idle_ms': config.maxConnectionIdle,
      'grpc.keepalive_time_ms': config.keepaliveTime,
      'grpc.keepalive_timeout_ms': config.keepaliveTimeout,
      'grpc.keepalive_permit_without_calls': 1,
      'grpc.http2.min_ping_interval_without_data_ms': 60000,
      'grpc.http2.max_pings_without_data': 0,
      
      // Interceptors (authentication, logging, error handling)
      interceptors: [
        loggingInterceptor,
        authInterceptor,
        errorInterceptor
      ]
    });

    // Register RelayerService
    const relayerService = new RelayerServiceImpl(this.connectionManager);
    this.server.addService(
      RelayerServiceService,
      relayerService as any
    );
  }

  /**
   * Start the gRPC server
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      throw new Error('gRPC server is already running');
    }

    const bindAddress = `${this.config.host}:${this.config.port}`;
    const credentials = this.getServerCredentials();

    return new Promise((resolve, reject) => {
      this.server.bindAsync(
        bindAddress,
        credentials,
        (error, port) => {
          if (error) {
            logger.error({ error, bindAddress },'[gRPC Server] Failed to bind');
            reject(error);
            return;
          }

          logger.info({
            host: this.config.host,
            port,
            tlsEnabled: this.config.tlsEnabled
          }, '[gRPC Server] 🚀 Server bound successfully');

          this.isRunning = true;
          resolve();
        }
      );
    });
  }

  /**
   * Stop the gRPC server gracefully
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    logger.info('[gRPC Server] 🛑 Stopping server...');

    // Close all active connections
    await this.connectionManager.closeAll();

    return new Promise((resolve) => {
      this.server.tryShutdown((error) => {
        if (error) {
          logger.error({ error }, '[gRPC Server] Error during shutdown');
          // Force shutdown if graceful fails
          this.server.forceShutdown();
        } else {
          logger.info('[gRPC Server] ✓ Server stopped gracefully');
        }
        
        this.isRunning = false;
        resolve();
      });
    });
  }

  /**
   * Force shutdown (non-graceful)
   */
  forceStop(): void {
    this.server.forceShutdown();
    this.isRunning = false;
    logger.warn('[gRPC Server] ⚠️  Forced shutdown');
  }

  /**
   * Get server credentials (TLS or insecure)
   */
  private getServerCredentials(): grpc.ServerCredentials {
    if (this.config.tlsEnabled) {
      if (!this.config.tlsCert || !this.config.tlsKey) {
        throw new Error('TLS enabled but cert/key not provided');
      }

      try {
        const cert = Buffer.from(this.config.tlsCert);
        const key = Buffer.from(this.config.tlsKey);

        return grpc.ServerCredentials.createSsl(
          null, // No client cert verification
          [{ cert, private_key: key }],
          false // Don't check client certificate
        );
      } catch (error) {
        logger.error({ error }, '[gRPC Server] Failed to create TLS credentials');
        throw error;
      }
    }

    logger.warn('[gRPC Server] ⚠️  Using insecure credentials (development only)');
    return grpc.ServerCredentials.createInsecure();
  }

  /**
   * Get connection statistics
   */
  getStats() {
    return {
      isRunning: this.isRunning,
      connections: this.connectionManager.getStats()
    };
  }

  /**
   * Get connection manager (for external access)
   */
  getConnectionManager(): ConnectionManager {
    return this.connectionManager;
  }
}

// Export singleton instance
let grpcServerInstance: GrpcServer | null = null;

export function createGrpcServer(config: GrpcServerConfig): GrpcServer {
  if (grpcServerInstance) {
    throw new Error('gRPC server already created');
  }
  grpcServerInstance = new GrpcServer(config);
  return grpcServerInstance;
}

export function getGrpcServer(): GrpcServer | null {
  return grpcServerInstance;
}