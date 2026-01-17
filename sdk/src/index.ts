/**
 * @fileoverview Consonant TypeScript SDK
 * @module @consonant/sdk
 * 
 * This is the official TypeScript SDK for the Consonant Agent Execution Platform.
 * It provides a clean, typed interface for registering agents and executing them.
 * 
 * DESIGN PHILOSOPHY:
 * The SDK is inspired by Inngest's excellent developer experience. It provides:
 * - Simple, intuitive API  
 * - Full TypeScript type safety
 * - Automatic retries and error handling
 * - Synchronous execution semantics (execute() returns the result)
 * 
 * USAGE EXAMPLE:
 * ```typescript
 * import { Consonant } from '@consonant/sdk'
 * 
 * const consonant = new Consonant({ apiKey: process.env.CONSONANT_API_KEY })
 * 
 * // One-time setup: Register an agent
 * await consonant.agents.register({
 *   name: 'complaint-analyzer',
 *   image: 'docker.io/acme/analyzer:v1',
 *   resources: { cpu: '2', memory: '4Gi', timeout: '300s' },
 *   retryPolicy: { maxAttempts: 3, backoff: 'exponential' }
 * })
 * 
 * // Execute and get the result
 * const result = await consonant.agents.execute({
 *   agent: 'complaint-analyzer',
 *   input: { complaint: 'Package never arrived!' }
 * })
 * 
 * console.log(result.severity) // 'high'
 * ```
 */

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
  status: 'completed' | 'failed';
  result: AgentOutput;
  durationMs: number;
  resourceUsage: ResourceUsage;
  completedAt: string;
  error?: {
    code: string;
    message: string;
  };
}

export interface Agent {
  id: string;
  name: string;
  image: string;
  description?: string;
  resources: AgentConfig['resources'];
  retryPolicy: AgentConfig['retryPolicy'];
  createdAt: string;
  updatedAt: string;
}

export interface ConsonantOptions {
  apiKey: string;
  baseUrl?: string;
  timeout?: number;
  debug?: boolean;
}

export class Consonant {
  private apiKey: string;
  private baseUrl: string;
  private timeout: number;
  private debug: boolean;

  constructor(options: ConsonantOptions) {
    if (!options.apiKey) {
      throw new Error('API key is required');
    }

    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl || 'https://api.consonant.dev';
    this.timeout = options.timeout || 120000;
    this.debug = options.debug || false;
  }

  public agents = {
    register: async (config: AgentConfig): Promise<Agent> => {
      return this.makeRequest<Agent>('POST', '/api/agents', config);
    },

    execute: async (request: {
      agent: string;
      input: AgentInput;
      priority?: Priority;
      cluster?: string;
    }): Promise<ExecutionResult> => {
      if (this.debug) {
        console.log('[Consonant] Executing agent:', request.agent);
      }

      const response = await this.makeRequest<{ executionId: string; status: string }>(
        'POST',
        '/api/executions',
        request
      );

      if (this.debug) {
        console.log('[Consonant] Execution queued:', response.executionId);
      }

      // Wait for completion
      const result = await this.waitForCompletion(response.executionId);
      
      if (this.debug) {
        console.log('[Consonant] Execution completed:', result.status);
      }

      return result;
    },

    list: async (options?: { limit?: number; offset?: number }): Promise<Agent[]> => {
      const params = new URLSearchParams();
      if (options?.limit) params.set('limit', options.limit.toString());
      if (options?.offset) params.set('offset', options.offset.toString());

      const response = await this.makeRequest<{ agents: Agent[] }>(
        'GET',
        `/api/agents?${params.toString()}`
      );

      return response.agents;
    },

    get: async (agentId: string): Promise<Agent> => {
      return this.makeRequest<Agent>('GET', `/api/agents/${agentId}`);
    },

    delete: async (agentId: string): Promise<void> => {
      await this.makeRequest<{ success: boolean }>('DELETE', `/api/agents/${agentId}`);
    },
  };

  private async makeRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    
    const options: RequestInit = {
      method,
      headers: {
        'X-API-Key': this.apiKey,
        'Content-Type': 'application/json',
      },
      ...(body && { body: JSON.stringify(body) }),
    };

    try {
      const response = await fetch(url, options);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new ConsonantError(
          errorData.message || `HTTP ${response.status}: ${response.statusText}`,
          response.status,
          errorData.error || 'api_error'
        );
      }

      return await response.json();
    } catch (error: any) {
      if (error instanceof ConsonantError) {
        throw error;
      }

      throw new ConsonantError(`Request failed: ${error.message}`, 0, 'network_error');
    }
  }

  /**
   * Wait for execution completion by polling the status endpoint.
   * 
   * This implementation polls the control plane's execution status endpoint
   * until the execution completes or times out. The polling interval starts
   * at 2 seconds and increases exponentially up to 30 seconds to balance
   * responsiveness with server load.
   * 
   * FUTURE ENHANCEMENT:
   * In a future version, this could use Server-Sent Events (SSE) or WebSockets
   * for real-time updates instead of polling. However, polling is simpler to
   * implement and works reliably across all network configurations.
   * 
   * @param executionId - Execution to wait for
   * @returns Execution result
   * @throws ConsonantError if execution fails or times out
   */
  private async waitForCompletion(executionId: string): Promise<ExecutionResult> {
    const maxAttempts = 240; // 2 hours maximum wait time
    const maxInterval = 30000; // Max 30 seconds between polls
    let attempts = 0;
    let interval = 2000; // Start with 2-second intervals

    while (attempts < maxAttempts) {
      try {
        // Query the execution status endpoint
        const status = await this.makeRequest<{
          executionId: string;
          status: string;
          result?: AgentOutput;
          error?: { code: string; message: string };
          durationMs?: number;
          resourceUsage?: ResourceUsage;
          completedAt?: string;
        }>('GET', `/api/executions/${executionId}`);

        if (this.debug) {
          console.log(`[Consonant] Execution status: ${status.status} (attempt ${attempts + 1})`);
        }

        // Check if completed successfully
        if (status.status === 'completed') {
          return {
            executionId: status.executionId,
            status: 'completed',
            result: status.result || {},
            durationMs: status.durationMs || 0,
            resourceUsage: status.resourceUsage || {
              cpuSeconds: 0,
              memoryMbSeconds: 0,
            },
            completedAt: status.completedAt || new Date().toISOString(),
          };
        }

        // Check if failed
        if (status.status === 'failed') {
          throw new ConsonantError(
            status.error?.message || 'Execution failed',
            500,
            status.error?.code || 'execution_failed'
          );
        }

        // Still running - wait before polling again
        await new Promise(resolve => setTimeout(resolve, interval));
        
        // Exponential backoff up to maxInterval
        interval = Math.min(interval * 1.5, maxInterval);
        attempts++;

      } catch (error) {
        // If the error is a ConsonantError, rethrow it
        if (error instanceof ConsonantError) {
          throw error;
        }

        // For network errors, retry with backoff
        if (this.debug) {
          console.log(`[Consonant] Polling error (will retry): ${error}`);
        }
        
        await new Promise(resolve => setTimeout(resolve, interval));
        interval = Math.min(interval * 1.5, maxInterval);
        attempts++;
      }
    }

    // Timeout after maximum attempts
    throw new ConsonantError(
      'Execution timed out after 2 hours. The agent may still be running.',
      408,
      'execution_timeout'
    );
  }
}

export class ConsonantError extends Error {
  constructor(message: string, public statusCode: number, public code: string) {
    super(message);
    this.name = 'ConsonantError';
  }
}

export default Consonant;