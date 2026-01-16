import { Server as SocketIOServer } from 'socket.io';
import { Server as HTTPServer } from 'http';
import { EventEmitter } from 'events';
import { createHash } from 'crypto';

interface ClusterConnection {
  clusterId: string;
  clusterName: string;
  socketId: string;
  connectedAt: number;
  lastHeartbeat: number;
  namespace: string;
  kagentVersion: string;
  tokenHash: string;
}

interface BackendSocketConfig {
  path: string;
  cors: {
    origin: string | string[];
    credentials: boolean;
  };
  pingTimeout: number;
  pingInterval: number;
  transports: string[];
}

export class ClusterRegistry {
  private clusters = new Map<string, ClusterConnection>();
  private socketToCluster = new Map<string, string>();
  
  register(cluster: ClusterConnection): void {
    this.clusters.set(cluster.clusterId, cluster);
    this.socketToCluster.set(cluster.socketId, cluster.clusterId);
  }

  unregister(clusterId: string): void {
    const cluster = this.clusters.get(clusterId);
    if (cluster) {
      this.socketToCluster.delete(cluster.socketId);
      this.clusters.delete(clusterId);
    }
  }

  get(clusterId: string): ClusterConnection | undefined {
    return this.clusters.get(clusterId);
  }

  getBySocketId(socketId: string): ClusterConnection | undefined {
    const clusterId = this.socketToCluster.get(socketId);
    return clusterId ? this.clusters.get(clusterId) : undefined;
  }

  updateHeartbeat(clusterId: string): void {
    const cluster = this.clusters.get(clusterId);
    if (cluster) {
      cluster.lastHeartbeat = Date.now();
    }
  }

  getAll(): ClusterConnection[] {
    return Array.from(this.clusters.values());
  }

  isConnected(clusterId: string): boolean {
    return this.clusters.has(clusterId);
  }

  clear(): void {
    this.clusters.clear();
    this.socketToCluster.clear();
  }
}

export class SocketManager extends EventEmitter {
  private io?: SocketIOServer;
  private registry = new ClusterRegistry();
  private heartbeatChecker?: NodeJS.Timeout;
  private readonly HEARTBEAT_TIMEOUT = 60000;

  constructor(private logger: any) {
    super();
  }

  initialize(server: HTTPServer, config: BackendSocketConfig): void {
    this.io = new SocketIOServer(server, {
      path: config.path,
      cors: config.cors,
      pingTimeout: config.pingTimeout,
      pingInterval: config.pingInterval,
      transports: config.transports as any,
      maxHttpBufferSize: 1e8,
      connectionStateRecovery: {
        maxDisconnectionDuration: 2 * 60 * 1000,
        skipMiddlewares: true,
      }
    });

    this.setupConnectionHandling();
    this.startHeartbeatChecker();
    
    this.logger.info({ config }, 'Backend socket manager initialized');
  }

  private setupConnectionHandling(): void {
    if (!this.io) return;

    this.io.on('connection', (socket) => {
      this.logger.info({ socketId: socket.id }, 'New socket connection');

      socket.on('cluster:register', async (data) => {
        await this.handleClusterRegistration(socket, data);
      });

      socket.on('cluster:heartbeat', (data) => {
        this.handleHeartbeat(socket, data);
      });

      socket.on('agent:trace', (data) => {
        this.handleAgentTrace(socket, data);
      });

      socket.on('agent:event', (data) => {
        this.handleAgentEvent(socket, data);
      });

      socket.on('k8s:event', (data) => {
        this.handleK8sEvent(socket, data);
      });

      socket.on('k8s:pod:status', (data) => {
        this.handlePodStatus(socket, data);
      });

      socket.on('otel:trace', (data) => {
        this.handleOtelTrace(socket, data);
      });

      socket.on('otel:metric', (data) => {
        this.handleOtelMetric(socket, data);
      });

      socket.on('cluster:error', (data) => {
        this.handleClusterError(socket, data);
      });

      socket.on('system:shutdown', (data) => {
        this.handleClusterShutdown(socket, data);
      });

      socket.on('invoke:response', (data) => {
        this.handleInvokeResponse(socket, data);
      });

      socket.on('invoke:error', (data) => {
        this.handleInvokeError(socket, data);
      });

      socket.on('disconnect', (reason) => {
        this.handleDisconnect(socket, reason);
      });

      socket.on('error', (error) => {
        this.logger.error({ socketId: socket.id, error }, 'Socket error');
      });
    });
  }

  private async handleClusterRegistration(socket: any, data: any): Promise<void> {
    try {
      const { clusterId, clusterName, token, kagentVersion, kagentConfig, namespace } = data;

      this.logger.info({ clusterId, clusterName, namespace }, 'Cluster registration attempt');

      const validationResult = await this.validateClusterRegistration(
        clusterId,
        clusterName,
        token,
        kagentVersion,
        namespace
      );

      if (!validationResult.valid) {
        socket.emit('registration:failed', {
          reason: validationResult.reason,
          timestamp: Date.now()
        });
        socket.disconnect(true);
        return;
      }

      const connection: ClusterConnection = {
        clusterId,
        clusterName,
        socketId: socket.id,
        connectedAt: Date.now(),
        lastHeartbeat: Date.now(),
        namespace,
        kagentVersion,
        tokenHash: createHash('sha256').update(token).digest('hex')
      };

      this.registry.register(connection);

      socket.emit('registration:success', {
        clusterId,
        timestamp: Date.now(),
        config: validationResult.config
      });

      this.emit('cluster:registered', {
        clusterId,
        clusterName,
        namespace,
        kagentVersion,
        kagentConfig
      });

      this.logger.info({ clusterId, clusterName }, 'Cluster registered successfully');
    } catch (error) {
      this.logger.error({ error, socketId: socket.id }, 'Registration error');
      socket.emit('registration:failed', {
        reason: 'Internal server error',
        timestamp: Date.now()
      });
      socket.disconnect(true);
    }
  }

  private async validateClusterRegistration(
    clusterId: string,
    clusterName: string,
    token: string,
    kagentVersion: string,
    namespace: string
  ): Promise<{ valid: boolean; reason?: string; config?: any }> {
    if (!clusterId || !clusterName || !token || !namespace) {
      return { valid: false, reason: 'Missing required fields' };
    }

    if (this.registry.isConnected(clusterId)) {
      return { valid: false, reason: 'Cluster already connected' };
    }

    this.emit('cluster:validate', {
      clusterId,
      clusterName,
      token,
      kagentVersion,
      namespace
    });

    return { 
      valid: true, 
      config: {
        otelEndpoint: process.env.OTEL_ENDPOINT || 'http://terra-backend:4317',
        metricsEnabled: true,
        tracingEnabled: true
      }
    };
  }

  private handleHeartbeat(socket: any, data: any): void {
    const cluster = this.registry.getBySocketId(socket.id);
    if (cluster) {
      this.registry.updateHeartbeat(cluster.clusterId);
    }
  }

  private handleAgentTrace(socket: any, data: any): void {
    const cluster = this.registry.getBySocketId(socket.id);
    if (cluster) {
      this.emit('agent:trace', { ...data, clusterId: cluster.clusterId });
    }
  }

  private handleAgentEvent(socket: any, data: any): void {
    const cluster = this.registry.getBySocketId(socket.id);
    if (cluster) {
      this.emit('agent:event', { ...data, clusterId: cluster.clusterId });
    }
  }

  private handleK8sEvent(socket: any, data: any): void {
    const cluster = this.registry.getBySocketId(socket.id);
    if (cluster) {
      this.emit('k8s:event', { ...data, clusterId: cluster.clusterId });
    }
  }

  private handlePodStatus(socket: any, data: any): void {
    const cluster = this.registry.getBySocketId(socket.id);
    if (cluster) {
      this.emit('k8s:pod:status', { ...data, clusterId: cluster.clusterId });
    }
  }

  private handleOtelTrace(socket: any, data: any): void {
    const cluster = this.registry.getBySocketId(socket.id);
    if (cluster) {
      this.emit('otel:trace', { ...data, clusterId: cluster.clusterId });
    }
  }

  private handleOtelMetric(socket: any, data: any): void {
    const cluster = this.registry.getBySocketId(socket.id);
    if (cluster) {
      this.emit('otel:metric', { ...data, clusterId: cluster.clusterId });
    }
  }

  private handleClusterError(socket: any, data: any): void {
    const cluster = this.registry.getBySocketId(socket.id);
    if (cluster) {
      this.logger.error({ clusterId: cluster.clusterId, error: data }, 'Cluster error');
      this.emit('cluster:error', { ...data, clusterId: cluster.clusterId });
    }
  }

  private handleClusterShutdown(socket: any, data: any): void {
    const cluster = this.registry.getBySocketId(socket.id);
    if (cluster) {
      this.logger.info({ clusterId: cluster.clusterId }, 'Cluster shutdown initiated');
      this.emit('cluster:shutdown', { ...data, clusterId: cluster.clusterId });
      this.registry.unregister(cluster.clusterId);
    }
  }

  private handleInvokeResponse(socket: any, data: any): void {
    const cluster = this.registry.getBySocketId(socket.id);
    if (cluster) {
      this.emit('invoke:response', { ...data, clusterId: cluster.clusterId });
    }
  }

  private handleInvokeError(socket: any, data: any): void {
    const cluster = this.registry.getBySocketId(socket.id);
    if (cluster) {
      this.emit('invoke:error', { ...data, clusterId: cluster.clusterId });
    }
  }

  private handleDisconnect(socket: any, reason: string): void {
    const cluster = this.registry.getBySocketId(socket.id);
    if (cluster) {
      this.logger.info({ 
        clusterId: cluster.clusterId, 
        reason 
      }, 'Cluster disconnected');
      
      this.emit('cluster:disconnected', {
        clusterId: cluster.clusterId,
        reason,
        timestamp: Date.now()
      });

      this.registry.unregister(cluster.clusterId);
    }
  }

  private startHeartbeatChecker(): void {
    this.heartbeatChecker = setInterval(() => {
      const now = Date.now();
      const clusters = this.registry.getAll();

      for (const cluster of clusters) {
        if (now - cluster.lastHeartbeat > this.HEARTBEAT_TIMEOUT) {
          this.logger.warn({ clusterId: cluster.clusterId }, 'Cluster heartbeat timeout');
          
          const socket = this.io?.sockets.sockets.get(cluster.socketId);
          if (socket) {
            socket.disconnect(true);
          }
          
          this.registry.unregister(cluster.clusterId);
          
          this.emit('cluster:timeout', {
            clusterId: cluster.clusterId,
            lastHeartbeat: cluster.lastHeartbeat
          });
        }
      }
    }, 30000);
  }

  invokeAgent(clusterId: string, request: any): boolean {
    const cluster = this.registry.get(clusterId);
    if (!cluster) {
      this.logger.warn({ clusterId }, 'Cannot invoke agent, cluster not found');
      return false;
    }

    const socket = this.io?.sockets.sockets.get(cluster.socketId);
    if (!socket) {
      this.logger.warn({ clusterId }, 'Cannot invoke agent, socket not found');
      return false;
    }

    socket.emit('invoke:agent', request);
    return true;
  }

  getConnectedClusters(): ClusterConnection[] {
    return this.registry.getAll();
  }

  isClusterConnected(clusterId: string): boolean {
    return this.registry.isConnected(clusterId);
  }

  async shutdown(): Promise<void> {
    this.logger.info('Shutting down backend socket manager');

    if (this.heartbeatChecker) {
      clearInterval(this.heartbeatChecker);
    }

    const clusters = this.registry.getAll();
    for (const cluster of clusters) {
      const socket = this.io?.sockets.sockets.get(cluster.socketId);
      if (socket) {
        socket.disconnect(true);
      }
    }

    this.registry.clear();

    if (this.io) {
      await new Promise<void>((resolve) => {
        this.io?.close(() => resolve());
      });
    }

    this.removeAllListeners();
    this.logger.info('Backend socket manager shutdown complete');
  }
}