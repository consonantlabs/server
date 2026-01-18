/**
 * @fileoverview Consonant TypeScript SDK
 * @module @consonant/sdk
 * 
 * This is the official TypeScript SDK for the Consonant Agent Execution Platform.
 * Built for performance, reliability, and ease of use in production environments.
 * 
 * FEATURES:
 * - Distributed ID tracking (RequestId, ExecutionId)
 * - Robust polling with exponential backoff & jitter
 * - Full type safety for Agent configurations and inputs
 * - Organization-scoped authentication
 */

import { z } from 'zod';

// =============================================================================
// VALIDATION SCHEMAS
// =============================================================================

const ResourcesSchema = z.object({
  cpu: z.string().regex(/^\d+(m|)$/, 'CPU must be a number or milli-cpus (e.g. "100m", "2")'),
  memory: z.string().regex(/^\d+(Mi|Gi)$/, 'Memory must be in Mi/Gi (e.g. "512Mi", "4Gi")'),
  gpu: z.string().regex(/^\d+$/, 'GPU must be an integer count').optional(),
  timeout: z.string().regex(/^\d+(s|m|h)$/, 'Timeout must be duration (e.g. "30s", "10m")'),
});

const RetryPolicySchema = z.object({
  maxAttempts: z.number().int().min(1).max(10),
  backoff: z.enum(['exponential', 'linear', 'constant']),
  initialDelay: z.string().optional(),
});

const AgentConfigSchema = z.object({
  name: z.string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9-]+$/, 'Name must be lowercase alphanumeric with hyphens'),
  image: z.string().min(1, 'Docker image required'),
  description: z.string().optional(),
  resources: ResourcesSchema,
  retryPolicy: RetryPolicySchema,
  useAgentSandbox: z.boolean().optional(),
  warmPoolSize: z.number().min(0).optional(),
  networkPolicy: z.enum(['restricted', 'standard', 'unrestricted']).optional(),
  environmentVariables: z.record(z.string(), z.string()).optional(),
});

const ExecutionRequestSchema = z.object({
  agent: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
  priority: z.enum(['high', 'normal', 'low']).default('normal'),
  cluster: z.string().optional(),
});

// =============================================================================
// TYPE DEFINITIONS
// =============================================================================

export interface AgentConfig {
  name: string;
  image: string;
  description?: string;
  resources: {
    cpu: string;
    memory: string;
    gpu?: string;
    timeout: string;
  };
  retryPolicy: {
    maxAttempts: number;
    backoff: 'exponential' | 'linear' | 'constant';
    initialDelay?: string;
  };
  useAgentSandbox?: boolean;
  warmPoolSize?: number;
  networkPolicy?: 'restricted' | 'standard' | 'unrestricted';
  environmentVariables?: Record<string, string>;
}

export type AgentInput = Record<string, unknown>;
export type AgentOutput = Record<string, unknown>;
export type Priority = 'high' | 'normal' | 'low';

export interface ResourceUsage {
  cpuSeconds: number;
  memoryMbSeconds: number;
  gpuSeconds?: number;
}

export interface ExecutionResult {
  executionId: string;
  status: 'COMPLETED' | 'FAILED' | 'PENDING' | 'QUEUED' | 'RUNNING';
  result?: AgentOutput;
  durationMs: number;
  resourceUsage: ResourceUsage;
  completedAt?: string;
  error?: {
    code: string;
    message: string;
  };
}

export interface Agent {
  id: string;
  name: string;
  image: string;
  status: 'PENDING' | 'ACTIVE' | 'FAILED';
  resources: AgentConfig['resources'];
  retryPolicy: AgentConfig['retryPolicy'];
  createdAt: string;
}

export interface ConsonantOptions {
  apiKey: string;
  baseUrl?: string;
  timeout?: number;
  debug?: boolean;
}

// =============================================================================
// ERROR HANDLING
// =============================================================================

export class ConsonantError extends Error {
  constructor(
    message: string,
    public statusCode: number = 0,
    public code: string = 'UNKNOWN_ERROR',
    public details?: any
  ) {
    super(message);
    this.name = 'ConsonantError';
    Object.setPrototypeOf(this, ConsonantError.prototype);
  }
}

// =============================================================================
// POLLING UTILITY (Exponential Backoff + Jitter)
// =============================================================================

interface PollOptions<T> {
  fn: () => Promise<T>;
  validate: (result: T) => boolean;
  maxWaitMs: number;
  initialIntervalMs: number;
  maxIntervalMs: number;
  onTimeout: () => Error;
}

async function pollWithBackoff<T>(options: PollOptions<T>): Promise<T> {
  const { fn, validate, maxWaitMs, initialIntervalMs, maxIntervalMs, onTimeout } = options;
  const startTime = Date.now();
  let currentInterval = initialIntervalMs;

  while (Date.now() - startTime < maxWaitMs) {
    try {
      const result = await fn();
      if (validate(result)) {
        return result;
      }
    } catch (err: any) {
      // Don't swallow fatal errors, only retry on potentially transient ones
      if (err instanceof ConsonantError && err.statusCode >= 400 && err.statusCode < 500 && err.statusCode !== 404 && err.statusCode !== 429) {
        throw err;
      }
    }

    // Calculate next interval with jitter
    const jitter = Math.random() * 0.2 + 0.9; // 0.9 - 1.1
    await new Promise(resolve => setTimeout(resolve, currentInterval * jitter));
    currentInterval = Math.min(currentInterval * 1.5, maxIntervalMs);
  }

  throw onTimeout();
}

// =============================================================================
// MAIN SDK CLIENT
// =============================================================================

export class Consonant {
  private apiKey: string;
  private baseUrl: string;
  private timeout: number;
  private debug: boolean;

  constructor(options: ConsonantOptions) {
    if (!options.apiKey) throw new Error('Consonant API Key is required');
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl?.replace(/\/$/, '') || 'https://api.consonant.dev';
    this.timeout = options.timeout || 300000; // 5 minutes default
    this.debug = options.debug || false;
  }

  /**
   * Agents Namespace
   * Focuses on registration and lifecycle.
   */
  public agents = {
    /**
     * Register or Update an Agent definition.
     * This is an asynchronous operation that returns a Task tracker.
     * Use .wait() to block until registration is active.
     */
    register: async (config: AgentConfig) => {
      AgentConfigSchema.parse(config);
      
      const response = await this.makeRequest<{ requestId: string; accepted: boolean }>(
        'POST',
        '/api/agents/register',
        config
      );

      return {
        requestId: response.requestId,
        wait: async (options?: { timeoutMs?: number }): Promise<Agent> => {
          return pollWithBackoff<Agent>({
            fn: async () => {
              // Note: We currently don't have a direct 'get agent by name' that's public for SDK?
              // Actually, we can check a registration status endpoint or list.
              // For now, using the intended registration polling pattern.
              const agentsResponse = await this.makeRequest<{ agents: Agent[] }>('GET', `/api/agents?name=${config.name}`);
              const agent = agentsResponse.agents.find(a => a.name === config.name);
              if (!agent) throw new ConsonantError('Agent not found yet', 404);
              return agent;
            },
            validate: (agent) => agent.status === 'ACTIVE',
            maxWaitMs: options?.timeoutMs || 60000, // 1 min for registration
            initialIntervalMs: 1000,
            maxIntervalMs: 5000,
            onTimeout: () => new ConsonantError('Registration timed out', 408, 'REGISTRATION_TIMEOUT')
          });
        }
      };
    },

    /**
     * Invoke/Execute an Agent.
     * Standardized way to trigger an agent and wait for results.
     */
    execute: async (request: {
      agent: string;
      input: AgentInput;
      priority?: Priority;
      cluster?: string;
    }) => {
      ExecutionRequestSchema.parse(request);

      const response = await this.makeRequest<{ executionId: string }>(
        'POST',
        '/api/execute',
        request
      );

      return {
        executionId: response.executionId,
        wait: async (options?: { timeoutMs?: number }): Promise<ExecutionResult> => {
          return pollWithBackoff<ExecutionResult>({
            fn: () => this.makeRequest<ExecutionResult>('GET', `/api/executions/${response.executionId}`),
            validate: (res) => res.status === 'COMPLETED' || res.status === 'FAILED',
            maxWaitMs: options?.timeoutMs || this.timeout,
            initialIntervalMs: 2000,
            maxIntervalMs: 30000,
            onTimeout: () => new ConsonantError('Execution timed out', 408, 'EXECUTION_TIMEOUT')
          });
        }
      };
    }
  };

  /**
   * Internal Request Helper
   */
  private async makeRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    if (this.debug) console.log(`[Consonant] ${method} ${url}`);

    const options: RequestInit = {
      method,
      headers: {
        'X-API-Key': this.apiKey,
        'Content-Type': 'application/json',
        'User-Agent': 'consonant-sdk-js/1.1.0'
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    };

    try {
      const response = await fetch(url, options);
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new ConsonantError(
          data.message || `HTTP ${response.status}`,
          response.status,
          data.code || 'API_ERROR',
          data.details
        );
      }

      return data as T;
    } catch (error: any) {
      if (error instanceof ConsonantError) throw error;
      throw new ConsonantError(`Network failed: ${error.message}`, 0, 'NETWORK_ERROR');
    }
  }
}

export default Consonant;