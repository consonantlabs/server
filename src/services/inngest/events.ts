/**
 * @fileoverview Inngest Event Type System
 * @module inngest/events
 * 
 * Complete type-safe event definitions for the Consonant agent execution platform.
 * This module defines every event that flows through the system with strict typing.
 * 
 * ARCHITECTURAL PATTERN:
 * We use Inngest's event-driven architecture where components communicate through
 * typed events rather than direct function calls. This provides durability,
 * observability, and loose coupling between system components.
 * 
 * EVENT CATEGORIES:
 * 1. Agent Lifecycle - Registration, updates, deletion
 * 2. Execution Flow - Request, queued, running, completed, failed
 * 3. Cluster Management - Registration, heartbeat, disconnect
 * 4. Observability - Logs, traces, metrics from running agents
 */

import { EventSchemas } from 'inngest';

/**
 * Agent configuration for registration.
 * This defines what container to run and how to run it.
 */
export interface AgentConfig {
  name: string;
  image: string;
  description?: string;
  resources: {
    cpu: string;        // e.g., "2" or "2000m"
    memory: string;     // e.g., "4Gi" or "4096Mi"
    gpu?: string;       // e.g., "1" for nvidia.com/gpu
    timeout: string;    // e.g., "300s" or "5m"
  };
  retryPolicy: {
    maxAttempts: number;      // How many times to retry on failure
    backoff: 'exponential' | 'linear' | 'constant';
    initialDelay?: string;    // e.g., "1s" - delay before first retry
  };
  // Optional advanced features
  useAgentSandbox?: boolean;  // Enable gVisor kernel isolation
  warmPoolSize?: number;      // Number of pre-warmed instances (premium feature)
  networkPolicy?: 'restricted' | 'standard' | 'unrestricted';
  environmentVariables?: Record<string, string>;
}

/**
 * Input data passed to an agent execution.
 * This is the actual data the agent will process.
 */
export type AgentInput = Record<string, unknown>;

/**
 * Output data returned from an agent execution.
 * The agent writes this as JSON to stdout.
 */
export type AgentOutput = Record<string, unknown>;

/**
 * Resource usage metrics from an execution.
 * Used for billing and analytics.
 */
export interface ResourceUsage {
  cpuSeconds: number;         // Total CPU time consumed
  memoryMbSeconds: number;    // Memory usage integrated over time
  gpuSeconds?: number;        // GPU time if GPU was used
  diskReadBytes?: number;     // Disk I/O metrics
  diskWriteBytes?: number;
  networkRxBytes?: number;    // Network traffic
  networkTxBytes?: number;
}

/**
 * Cluster capabilities reported during registration.
 * Helps the control plane decide where to schedule executions.
 */
export interface ClusterCapabilities {
  kubernetes: {
    version: string;          // e.g., "1.28.5"
    provider?: string;        // e.g., "aws", "gcp", "azure"
  };
  resources: {
    totalCpu: string;         // Total CPU cores in cluster
    totalMemory: string;      // Total memory in cluster
    gpuNodes: number;         // Number of nodes with GPUs
    gpuType?: string;         // e.g., "nvidia-tesla-v100"
  };
  region?: string;            // Geographic region for data locality
  availabilityZone?: string;
}

/**
 * Complete event schema for Inngest.
 * Every event in the system must be defined here with full typing.
 */
export type ConsonantEvents = {
  // =========================================================================
  // AGENT LIFECYCLE EVENTS
  // =========================================================================

  /**
   * Triggered when a customer registers a new agent.
   * This is a one-time setup event that stores the agent definition.
   */
  'agent.registered': {
    data: {
      agentId: string;
      apiKeyId: string;     // Which customer owns this agent
      config: AgentConfig;
      createdAt: string;      // ISO 8601 timestamp
    };
  };

  /**
   * Triggered when an agent's configuration is updated.
   * For example, changing resource requirements or retry policy.
   */
  'agent.updated': {
    data: {
      agentId: string;
      apiKeyHash: string;
      changes: Partial<AgentConfig>;
      updatedAt: string;
    };
  };

  /**
   * Triggered when an agent is deleted.
   * Cleanup operations can listen to this event.
   */
  'agent.deleted': {
    data: {
      agentId: string;
      apiKeyHash: string;
      deletedAt: string;
    };
  };

  // =========================================================================
  // EXECUTION FLOW EVENTS
  // =========================================================================

  /**
   * Triggered when SDK calls execute().
   * This starts the durable execution workflow.
   * 
   * CRITICAL: The Inngest function handling this event will waitForEvent()
   * until execution completes, then return the result to the SDK caller.
   */
  'agent.execution.requested': {
    data: {
      executionId: string;
      agentId: string;
      apiKeyId: string;
      input: AgentInput;
      priority: 'high' | 'normal' | 'low';
      cluster?: string;       // Optional: specific cluster to use
      requestedAt: string;
    };
  };

  /**
   * Triggered when execution is queued to a specific cluster.
   * The relayer will pick this up via gRPC stream.
   */
  'agent.execution.queued': {
    data: {
      executionId: string;
      agentId: string;
      clusterId: string;
      queuedAt: string;
    };
  };

  /**
   * Triggered when the agent actually starts running in Kubernetes.
   * Reported by the relayer after the Pod starts.
   */
  'agent.execution.started': {
    data: {
      executionId: string;
      agentId: string;
      clusterId: string;
      podName: string;        // Kubernetes pod name for debugging
      startedAt: string;
    };
  };

  /**
   * Triggered when the agent completes successfully.
   * This wakes up the waiting Inngest function to return the result.
   * 
   * CRITICAL: This is what the execution workflow waits for with waitForEvent().
   */
  'agent.execution.completed': {
    data: {
      executionId: string;
      agentId: string;
      clusterId: string;
      result: AgentOutput;
      durationMs: number;
      resourceUsage: ResourceUsage;
      completedAt: string;
    };
  };

  /**
   * Triggered when the agent fails (crashes, times out, or is killed).
   * The workflow will retry according to the retry policy.
   */
  'agent.execution.failed': {
    data: {
      executionId: string;
      agentId: string;
      clusterId: string;
      error: {
        code: string;         // e.g., "TIMEOUT", "OOM_KILLED", "EXIT_CODE_1"
        message: string;
        exitCode?: number;
        signal?: string;
      };
      attempt: number;        // Which retry attempt this was
      willRetry: boolean;     // Whether we'll retry again
      failedAt: string;
    };
  };

  /**
   * Triggered when all retry attempts are exhausted.
   * This is the final failure state - no more retries will happen.
   */
  'agent.execution.exhausted': {
    data: {
      executionId: string;
      agentId: string;
      error: {
        code: string;
        message: string;
        allAttempts: Array<{
          attempt: number;
          error: string;
          failedAt: string;
        }>;
      };
      exhaustedAt: string;
    };
  };

  // =========================================================================
  // API KEY EVENTS
  // =========================================================================

  /**
   * Triggered when a new API key is created.
   */
  'apikey.created': {
    data: {
      organizationId: string;
      keyId: string;
      name: string;
      timestamp: string;
    };
  };

  /**
   * Triggered when an API key is rotated.
   */
  'apikey.rotated': {
    data: {
      organizationId: string;
      keyId: string;
      timestamp: string;
    };
  };

  /**
   * Triggered when an API key is revoked.
   */
  'apikey.revoked': {
    data: {
      organizationId: string;
      keyId: string;
      timestamp: string;
    };
  };

  // =========================================================================
  // CLUSTER MANAGEMENT EVENTS
  // =========================================================================

  /**
   * Triggered when a Kubernetes cluster connects to the control plane.
   * The relayer sends this when it first establishes the gRPC stream.
   */
  'cluster.connected': {
    data: {
      clusterId: string;
      apiKeyId: string;     // Which customer owns this cluster
      capabilities: ClusterCapabilities;
      relayerVersion: string;
      connectedAt: string;
    };
  };

  /**
   * Triggered periodically while cluster is connected.
   * Confirms the cluster is still alive and responsive.
   */
  'cluster.heartbeat': {
    data: {
      clusterId: string;
      status: {
        activePods: number;
        availableResources: {
          cpu: string;
          memory: string;
        };
      };
      heartbeatAt: string;
    };
  };

  /**
   * Triggered when a cluster disconnects (gracefully or due to error).
   * Executions on this cluster may need to be rescheduled.
   */
  'cluster.disconnected': {
    data: {
      clusterId: string;
      reason: 'graceful' | 'timeout' | 'error';
      error?: string;
      disconnectedAt: string;
    };
  };

  // =========================================================================
  // OBSERVABILITY EVENTS
  // =========================================================================

  /**
   * Triggered when agent emits log lines to stdout/stderr.
   * Streamed from relayer in real-time.
   */
  'agent.log.batch': {
    data: {
      executionId: string;
      logs: Array<{
        timestamp: string;
        level: 'debug' | 'info' | 'warn' | 'error';
        message: string;
        stream: 'stdout' | 'stderr';
      }>;
    };
  };

  /**
   * Triggered when agent emits OpenTelemetry traces.
   * Provides detailed execution timeline for debugging.
   */
  'agent.trace.batch': {
    data: {
      executionId: string;
      traces: Array<{
        traceId: string;
        spanId: string;
        parentSpanId?: string;
        name: string;
        startTime: string;
        endTime: string;
        attributes: Record<string, unknown>;
      }>;
    };
  };

  /**
   * Triggered when agent emits resource usage metrics.
   * Used for real-time monitoring and billing.
   */
  'agent.metrics.batch': {
    data: {
      executionId: string;
      metrics: Array<{
        timestamp: string;
        name: string;
        value: number;
        unit: string;
        tags?: Record<string, string>;
      }>;
    };
  };

  /**
   * Triggered when a request timeline segment is completed.
   */
  'request.timeline.completed': {
    data: {
      timeline: {
        requestId: string;
        traceId: string;
        organizationId?: string;
        method: string;
        path: string;
        statusCode: number;
        startTime: string;
        endTime: string;
        duration: number;
        events: Array<{
          name: string;
          timestamp: string;
          duration: number;
          metadata?: Record<string, unknown>;
        }>;
        query?: Record<string, string>;
        timestamp: string;
      };
    };
  };

  /**
   * Telemetry trace batch.
   */
  'telemetry.trace.batch': {
    data: {
      organizationId: string;
      clusterId: string;
      traces: Array<any>;
    };
  };

  /**
   * Telemetry metric batch.
   */
  'telemetry.metric.batch': {
    data: {
      organizationId: string;
      clusterId: string;
      metrics: Array<any>;
    };
  };

  /**
   * Telemetry log batch.
   */
  'telemetry.log.batch': {
    data: {
      organizationId: string;
      clusterId: string;
      logs: Array<any>;
    };
  };

  /**
   * Cluster error event.
   */
  'cluster.error': {
    data: {
      clusterId: string;
      error: string;
      timestamp: string;
    };
  };

  /**
   * API key events.
   */
  'apikey.created': {
    data: {
      organizationId: string;
      keyId: string;
      name: string;
      timestamp: string;
    };
  };

  'apikey.rotated': {
    data: {
      organizationId: string;
      keyId: string;
      timestamp: string;
    };
  };

  'apikey.revoked': {
    data: {
      organizationId: string;
      keyId: string;
      timestamp: string;
    };
  };
};

/**
 * Helper type to extract event data from an event name.
 * Usage: EventData<'agent.execution.completed'> returns the data type for that event.
 */
export type EventData<T extends keyof ConsonantEvents> = ConsonantEvents[T]['data'];

export const schemas = new EventSchemas().fromRecord<ConsonantEvents>();

/**
 * Status enum for execution tracking.
 * Matches the state machine in the Execution model.
 */
export enum ExecutionStatus {
  PENDING = 'pending',
  QUEUED = 'queued',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

/**
 * Cluster status enum.
 * Matches the Prisma schema.
 */
export enum ClusterStatus {
  PENDING = 'PENDING',
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
  FAILED = 'FAILED',
}