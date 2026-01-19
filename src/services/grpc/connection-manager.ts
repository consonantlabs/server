import * as grpc from '@grpc/grpc-js';
import { EventEmitter } from 'events';
import { logger } from '../../utils/logger.js';
import { Redis } from 'ioredis';

/**
 * ConnectionManager handles the lifecycle of gRPC bidirectional streams
 * between the control plane and relayers in (Kubernetes clusters).
 * 
 * SCALABILITY DESIGN:
 * In a multi-pod Control Plane, a relayer connects to a single pod.
 * To manage global state (e.g. key rotations), we use Redis PubSub to 
 * propagate signals across all control plane pods.
 * 
 * LIVENESS:
 * We use Redis with TTL (60s) for "Global Liveness" so other services 
 * know which clusters are actually reachable.
 */
export class ConnectionManager extends EventEmitter {
    private streams = new Map<string, grpc.ServerDuplexStream<any, any>>();
    private heartbeats = new Map<string, NodeJS.Timeout>();
    private redis: Redis | null = null;
    private subscriber: Redis | null = null;
    private readonly SIGNAL_CHANNEL = 'control-plane:signals';

    /**
     * Initialize Redis-backed signaling and liveness.
     * Call this at startup.
     */
    async init(redisUrl: string): Promise<void> {
        this.redis = new Redis(redisUrl);
        this.subscriber = new Redis(redisUrl);

        // Listen for signals from other pods
        await this.subscriber.subscribe(this.SIGNAL_CHANNEL);
        this.subscriber.on('message', (channel, message) => {
            if (channel === this.SIGNAL_CHANNEL) {
                this.handleSignal(message);
            }
        });

        logger.info('ConnectionManager initialized with Redis signaling');
    }

    /**
     * Handle signals received via Redis PubSub (cross-pod coordination).
     */
    private handleSignal(rawMessage: string): void {
        try {
            const signal = JSON.parse(rawMessage);
            const { type, clusterId, payload } = signal;

            switch (type) {
                case 'UNREGISTER_STREAM':
                    // If we have the stream for this cluster, close it
                    if (this.streams.has(clusterId)) {
                        logger.info({ clusterId }, '[Signal] Closing local stream per remote request');
                        this.unregisterStream(clusterId, false); // Don't re-propagate
                    }
                    break;
                case 'CONFIG_UPDATE':
                    // If we have the stream, send the update
                    if (this.streams.has(clusterId)) {
                        logger.info({ clusterId }, '[Signal] Pushing remote config update to cluster');
                        this.sendToCluster(clusterId, payload);
                    }
                    break;
            }
        } catch (err) {
            logger.error({ err }, 'Failed to handle Redis signal');
        }
    }

    /**
     * Register a new active bidirectional stream for a cluster.
     * 
     * This method is the entry point for a connected Relayer. It:
     * 1. Broadcasts a signal to close any stale streams for this ID on other pods.
     * 2. Sets the local stream instance.
     * 3. Initializes the Heartbeat Reaper (2-minute timeout).
     * 4. Updates global liveness in Redis with a 60s TTL.
     * 
     * @param clusterId - Unique ID of the cluster
     * @param call - The gRPC duplex stream
     */
    async registerStream(clusterId: string, call: grpc.ServerDuplexStream<any, any>): Promise<void> {
        // 1. Signal other pods to clear stale connections for this ID
        await this.broadcastSignal('UNREGISTER_STREAM', clusterId);

        const existing = this.streams.get(clusterId);
        if (existing) {
            existing.destroy();
        }

        this.streams.set(clusterId, call);
        this.resetHeartbeatTimeout(clusterId);

        // 2. Set Global Liveness in Redis
        if (this.redis) {
            await this.redis.set(`cluster:${clusterId}:alive`, 'true', 'EX', 60);
        }

        this.emit('connected', clusterId);
        logger.info({ clusterId, activeConnections: this.streams.size }, 'Cluster stream registered (Global)');
    }

    /**
     * Unregister a stream and clean up resources.
     * 
     * @param clusterId - Cluster to disconnect
     * @param propagate - If true, notifies other pods to also clear this cluster (used for manual deletion)
     */
    async unregisterStream(clusterId: string, propagate: boolean = true): Promise<void> {
        const stream = this.streams.get(clusterId);
        if (stream) {
            logger.info({ clusterId }, 'Closing local stream');
            stream.destroy();
            this.streams.delete(clusterId);
        }

        const timeout = this.heartbeats.get(clusterId);
        if (timeout) {
            clearTimeout(timeout);
            this.heartbeats.delete(clusterId);
        }

        // Clear Global Liveness
        if (this.redis) {
            await this.redis.del(`cluster:${clusterId}:alive`);
        }

        if (propagate) {
            await this.broadcastSignal('UNREGISTER_STREAM', clusterId);
        }

        this.emit('disconnected', clusterId);
    }

    /**
     * Broadcast a control signal to all pods in the Control Plane fleet.
     * 
     * @param type - Signal type (e.g., CONFIG_UPDATE, UNREGISTER_STREAM)
     * @param clusterId - Target cluster
     * @param payload - Optional data payload
     */
    async broadcastSignal(type: string, clusterId: string, payload?: any): Promise<void> {
        if (this.redis) {
            await this.redis.publish(this.SIGNAL_CHANNEL, JSON.stringify({ type, clusterId, payload }));
        }
    }

    /**
     * Send a message to a cluster (hot path).
     * 
     * If the cluster is connected to THIS pod, it writes directly to the stream.
     * If the cluster is connected to ANOTHER pod, it broadcasts a signal via Redis.
     * 
     * @param clusterId - Target cluster ID
     * @param message - Protobuf-compatible message object
     * @returns Boolean indicating if the message was sent/broadcasted
     */
    async sendToCluster(clusterId: string, message: any): Promise<boolean> {
        const stream = this.streams.get(clusterId);

        if (stream) {
            try {
                stream.write(message);
                return true;
            } catch (err) {
                logger.error({ err, clusterId }, 'Failed to write to local stream');
                await this.unregisterStream(clusterId);
                return false;
            }
        }

        // If not local, broadcast to other pods
        await this.broadcastSignal('CONFIG_UPDATE', clusterId, message);
        return true; // Assume delivery via broadcast
    }

    /**
     * Handle heartbeat from cluster.
     * Updates local timeout AND global liveness TTL.
     */
    async handleHeartbeat(clusterId: string): Promise<void> {
        this.resetHeartbeatTimeout(clusterId);

        if (this.redis) {
            await this.redis.expire(`cluster:${clusterId}:alive`, 60);
        }

        this.emit('heartbeat', clusterId);
    }

    /**
     * Check if a cluster is globally connected.
     * Queries Redis for global liveness state.
     * 
     * @param clusterId - Cluster ID to check
     * @returns True if cluster is connected to ANY pod in the fleet
     */
    async isGloballyConnected(clusterId: string): Promise<boolean> {
        if (this.redis) {
            const alive = await this.redis.get(`cluster:${clusterId}:alive`);
            return alive === 'true';
        }
        // Fallback to local check if Redis is not initialized
        return this.streams.has(clusterId);
    }

    /**
     * Check if connected locally.
     */
    isConnected(clusterId: string): boolean {
        return this.streams.has(clusterId);
    }

    /**
     * Resets the inactivity timeout for a cluster.
     * If no heartbeat/message is received for 2 minutes, the connection is reaped.
     */
    private resetHeartbeatTimeout(clusterId: string): void {
        const existing = this.heartbeats.get(clusterId);
        if (existing) clearTimeout(existing);

        const timeout = setTimeout(async () => {
            logger.warn({ clusterId }, 'Local connection reaped (no heartbeat)');
            await this.unregisterStream(clusterId, false); // Just local reap, don't re-propagate
        }, 120000); // 2 minutes

        this.heartbeats.set(clusterId, timeout);
    }

    /**
     * Get IDs of clusters connected specifically to this pod.
     */
    getLocalClusters(): string[] {
        return Array.from(this.streams.keys());
    }
}

// Singleton instance
let managerInstance: ConnectionManager | null = null;

/**
 * Get or create the ConnectionManager instance.
 */
export function getConnectionManager(): ConnectionManager {
    if (!managerInstance) {
        managerInstance = new ConnectionManager();
    }
    return managerInstance;
}
