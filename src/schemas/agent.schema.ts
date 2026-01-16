/**
 * src/manifest/schemas/terra-agent.schema.ts
 * 
 * Zod schemas for validating Terra Agent manifests.
 * Provides runtime type safety and detailed error messages.
 * 
 * Usage:
 *   import { TerraAgentSchema } from './terra-agent.schema';
 *   const result = TerraAgentSchema.safeParse(data);
 */

import { z } from 'zod';

// ============================================================================
// BASIC SCHEMAS
// ============================================================================

/**
 * DNS-1123 compliant name validation
 * - Lowercase alphanumeric characters or '-'
 * - Must start and end with alphanumeric character
 * - Max 63 characters
 */
const DNS1123NameSchema = z
  .string()
  .min(1, 'Name cannot be empty')
  .max(63, 'Name cannot exceed 63 characters')
  .regex(
    /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/,
    'Name must be lowercase alphanumeric with optional hyphens, starting and ending with alphanumeric'
  );

/**
 * Kubernetes resource quantity validation
 * Supports:
 * - Plain numbers: "1", "2.5"
 * - Millicores: "100m", "500m"
 * - Memory units: "128Mi", "1Gi", "2G"
 */
const ResourceQuantitySchema = z
  .string()
  .min(1, 'Resource quantity cannot be empty')
  .regex(
    /^(\d+\.?\d*|\d*\.?\d+)(m|Ki|Mi|Gi|Ti|Pi|Ei|K|M|G|T|P|E)?$/,
    'Invalid resource quantity format. Examples: "1", "250m", "512Mi", "1Gi"'
  );

/**
 * Container image validation
 * Supports:
 * - Docker Hub: "nginx", "library/nginx"
 * - Private registries: "registry.example.com/image:tag"
 * - With tag: "nginx:1.21"
 * - With digest: "nginx@sha256:..."
 */
const ContainerImageSchema = z
  .string()
  .min(1, 'Image cannot be empty')
  .regex(
    /^[a-z0-9.:/-]+(@sha256:[a-f0-9]{64})?$/i,
    'Invalid container image format'
  );

/**
 * Environment variable name validation
 * Must be valid shell variable name
 */
const EnvVarNameSchema = z
  .string()
  .regex(
    /^[A-Z_][A-Z0-9_]*$/,
    'Environment variable name must be uppercase alphanumeric with underscores'
  );

// ============================================================================
// TERRA AGENT SCHEMAS
// ============================================================================

/**
 * Agent metadata schema
 */
export const TerraAgentMetadataSchema = z.object({
  name: DNS1123NameSchema.describe('Unique name for the agent'),
  namespace: DNS1123NameSchema
    .optional()
    .describe('Namespace for the agent (defaults to terra-agents)'),
  labels: z
    .record(z.string(), z.string())
    .optional()
    .describe('Key-value labels for organization'),
  annotations: z
    .record(z.string(), z.string())
    .optional()
    .describe('Key-value annotations for metadata'),
});

/**
 * Runtime specification schema
 */
export const TerraRuntimeSpecSchema = z.object({
  image: ContainerImageSchema.describe('Container image to run'),
  entrypoint: z
    .string()
    .optional()
    .describe('Optional entrypoint override'),
  args: z
    .array(z.string())
    .optional()
    .describe('Optional command arguments'),
  env: z
    .record(EnvVarNameSchema, z.string())
    .optional()
    .describe('Environment variables'),
});

/**
 * Resource specification schema
 */
export const TerraResourcesSpecSchema = z.object({
  cpu: ResourceQuantitySchema.describe('CPU request (e.g., "250m", "1")'),
  memory: ResourceQuantitySchema.describe('Memory request (e.g., "256Mi", "1Gi")'),
});

/**
 * Scaling specification schema
 */
export const TerraScalingSpecSchema = z.object({
  replicas: z
    .number()
    .int()
    .positive('Replicas must be positive')
    .max(100, 'Replicas cannot exceed 100')
    .describe('Number of pod replicas'),
});

/**
 * Deployment specification schema
 */
export const TerraDeploymentSpecSchema = z.object({
  resources: TerraResourcesSpecSchema.describe('Resource requests'),
  scaling: TerraScalingSpecSchema.describe('Scaling configuration'),
});

/**
 * Resource limits schema
 */
export const TerraResourceLimitsSpecSchema = z.object({
  maxCpu: ResourceQuantitySchema.describe('Maximum CPU allocation'),
  maxMemory: ResourceQuantitySchema.describe('Maximum memory allocation'),
});

/**
 * Scaling limits schema
 */
export const TerraScalingLimitsSpecSchema = z.object({
  maxReplicas: z
    .number()
    .int()
    .positive('Max replicas must be positive')
    .max(1000, 'Max replicas cannot exceed 1000')
    .describe('Maximum number of replicas'),
});

/**
 * Limits specification schema
 */
export const TerraLimitsSpecSchema = z.object({
  resources: TerraResourceLimitsSpecSchema.describe('Resource limits'),
  scaling: TerraScalingLimitsSpecSchema.describe('Scaling limits'),
});

/**
 * Tool specification schema
 */
export const TerraToolSpecSchema = z.object({
  name: z
    .string()
    .min(1, 'Tool name cannot be empty')
    .describe('Tool name'),
  description: z
    .string()
    .optional()
    .describe('Tool description'),
  config: z
    .record(z.string(), z.any())
    .optional()
    .describe('Tool configuration'),
});

/**
 * Approvals specification schema
 */
export const TerraApprovalsSpecSchema = z.object({
  requiredFor: z
    .array(z.string())
    .optional()
    .describe('Tools requiring approval'),
});

/**
 * Policies specification schema
 */
export const TerraPoliciesSpecSchema = z.object({
  approvals: TerraApprovalsSpecSchema
    .optional()
    .describe('Approval requirements'),
});

/**
 * Agent specification schema
 */
export const TerraAgentSpecSchema = z.object({
  description: z
    .string()
    .max(500, 'Description cannot exceed 500 characters')
    .optional()
    .describe('Human-readable description'),
  runtime: TerraRuntimeSpecSchema.describe('Runtime configuration'),
  deployment: TerraDeploymentSpecSchema.describe('Deployment configuration'),
  limits: TerraLimitsSpecSchema.describe('Resource and scaling limits'),
  capabilities: z
    .array(z.string())
    .optional()
    .describe('Agent capabilities'),
  tools: z
    .array(TerraToolSpecSchema)
    .optional()
    .describe('Agent tools'),
  policies: TerraPoliciesSpecSchema
    .optional()
    .describe('Agent policies'),
});

/**
 * Complete Terra Agent manifest schema
 * 
 * @example
 * ```typescript
 * const manifest = {
 *   apiVersion: 'terra.dev/v1',
 *   kind: 'Agent',
 *   metadata: {
 *     name: 'code-reviewer',
 *     namespace: 'terra-agents'
 *   },
 *   spec: {
 *     runtime: {
 *       image: 'myorg/code-reviewer:1.2.0',
 *       env: {
 *         MODEL: 'gpt-4'
 *       }
 *     },
 *     deployment: {
 *       resources: {
 *         cpu: '250m',
 *         memory: '256Mi'
 *       },
 *       scaling: {
 *         replicas: 2
 *       }
 *     },
 *     limits: {
 *       resources: {
 *         maxCpu: '1',
 *         maxMemory: '1Gi'
 *       },
 *       scaling: {
 *         maxReplicas: 10
 *       }
 *     }
 *   }
 * };
 * 
 * const result = TerraAgentSchema.safeParse(manifest);
 * if (result.success) {
 *   console.log('Valid!', result.data);
 * } else {
 *   console.error('Invalid:', result.error.format());
 * }
 * ```
 */
export const TerraAgentSchema = z.object({
  apiVersion: z
    .literal('terra.dev/v1')
    .describe('API version (must be terra.dev/v1)'),
  kind: z
    .literal('Agent')
    .describe('Resource kind (must be Agent)'),
  metadata: TerraAgentMetadataSchema.describe('Agent metadata'),
  spec: TerraAgentSpecSchema.describe('Agent specification'),
});

// ============================================================================
// TYPE INFERENCE
// ============================================================================

/**
 * Inferred TypeScript types from Zod schemas
 * These types are automatically kept in sync with the schemas
 */
export type TerraAgentManifest = z.infer<typeof TerraAgentSchema>;
export type TerraAgentMetadata = z.infer<typeof TerraAgentMetadataSchema>;
export type TerraAgentSpec = z.infer<typeof TerraAgentSpecSchema>;
export type TerraRuntimeSpec = z.infer<typeof TerraRuntimeSpecSchema>;
export type TerraDeploymentSpec = z.infer<typeof TerraDeploymentSpecSchema>;
export type TerraResourcesSpec = z.infer<typeof TerraResourcesSpecSchema>;
export type TerraScalingSpec = z.infer<typeof TerraScalingSpecSchema>;
export type TerraLimitsSpec = z.infer<typeof TerraLimitsSpecSchema>;
export type TerraResourceLimitsSpec = z.infer<typeof TerraResourceLimitsSpecSchema>;
export type TerraScalingLimitsSpec = z.infer<typeof TerraScalingLimitsSpecSchema>;
export type TerraToolSpec = z.infer<typeof TerraToolSpecSchema>;
export type TerraPoliciesSpec = z.infer<typeof TerraPoliciesSpecSchema>;
export type TerraApprovalsSpec = z.infer<typeof TerraApprovalsSpecSchema>;

// ============================================================================
// VALIDATION HELPERS
// ============================================================================

/**
 * Validate a Terra agent manifest and return detailed errors
 * 
 * @param data - The data to validate
 * @returns Validation result with typed data or detailed errors
 */
export function validateTerraAgent(data: unknown) {
  const result = TerraAgentSchema.safeParse(data);
  
  if (!result.success) {
    // Format errors for better readability
    const errors = result.error.issues.map((issue) => {
      const path = issue.path.join('.');
      return `${path}: ${issue.message}`;
    });
    
    return {
      valid: false as const,
      errors,
      data: undefined,
    };
  }
  
  return {
    valid: true as const,
    errors: [],
    data: result.data,
  };
}

/**
 * Strict validation that throws on error
 * Useful for internal processing where we expect valid data
 * 
 * @param data - The data to validate
 * @returns The validated and typed data
 * @throws {z.ZodError} If validation fails
 */
export function strictValidateTerraAgent(data: unknown): TerraAgentManifest {
  return TerraAgentSchema.parse(data);
}