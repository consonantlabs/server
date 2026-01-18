/**
 * @fileoverview Environment Configuration
 * @module config/env
 * 
 * Validates and provides type-safe access to environment variables.
 * Uses Zod for runtime validation to catch configuration errors at startup.
 * 
 * @example
 * import { env } from '@/config/env';
 * console.log(env.PORT); // Type-safe access
 */

import { z } from 'zod';
import { config } from 'dotenv';

// Load environment variables from .env file
config();

/**
 * Environment variable schema with validation rules.
 * 
 * This schema ensures all required configuration is present and valid
 * before the application starts. Missing or invalid configuration will
 * cause the application to fail fast with clear error messages.
 */
const envSchema = z.object({
  // ============================================================================
  // Server Configuration
  // ============================================================================

  /** Node environment: development, test, or production */
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  /** HTTP server port */
  PORT: z.coerce.number().int().positive().default(3000),

  /** HTTP server host */
  HOST: z.string().default('0.0.0.0'),

  /** Log level for Pino logger */
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  // ============================================================================
  // Database Configuration
  // ============================================================================

  /** 
   * Database connection URL for operational data.
   * Supports PostgreSQL, SQLite, and MySQL.
   * Provider is auto-detected from URL at runtime.
   * 
   * Examples:
   * - PostgreSQL: postgresql://user:pass@localhost:5432/db
   * - SQLite: file:./local.db
   */
  DATABASE_URL: z.string().min(1),

  /**
   * TimescaleDB connection URL for time-series telemetry and request timelines.
   * This should be a separate PostgreSQL database with TimescaleDB extension.
   * Allows independent scaling and retention policies from operational data.
   * 
   * If not provided, the application will fall back to using DATABASE_URL.
   * 
   * Example: postgresql://user:pass@localhost:5432/consonant_timeseries
   */
  TIMESCALE_DB_URL: z.string().optional(),

  /**
   * JWT secret for signing authentication tokens.
   * Must be at least 32 characters for security.
   * Keep this secret and rotate periodically.
   * 
   * Example: use `openssl rand -base64 32` to generate
   */
  JWT_SECRET: z.string().min(32),

  // ============================================================================
  // Redis Configuration
  // ============================================================================

  /** Redis connection URL for rate limiting and caching */
  REDIS_URL: z.string().url().default('redis://localhost:6379'),

  /** Redis key prefix to avoid collisions */
  REDIS_PREFIX: z.string().default('consonant:'),

  // ============================================================================
  // gRPC Server Configuration
  // ============================================================================

  /** gRPC server port for cluster connections */
  GRPC_PORT: z.coerce.number().int().positive().default(50051),

  /** gRPC server host */
  GRPC_HOST: z.string().default('0.0.0.0'),

  /** Enable TLS for gRPC connections */
  GRPC_TLS_ENABLED: z.coerce.boolean().default(false),

  /** Path to TLS certificate file (required if TLS enabled) */
  GRPC_TLS_CERT: z.string().optional(),

  /** Path to TLS private key file (required if TLS enabled) */
  GRPC_TLS_KEY: z.string().optional(),

  /** Maximum connection age in milliseconds */
  GRPC_MAX_CONNECTION_AGE: z.coerce.number().int().positive().default(3600000), // 1 hour

  /** Maximum connection idle time in milliseconds */
  GRPC_MAX_CONNECTION_IDLE: z.coerce.number().int().positive().default(300000), // 5 minutes

  /** Keepalive time in milliseconds */
  GRPC_KEEPALIVE_TIME: z.coerce.number().int().positive().default(30000), // 30 seconds

  /** Keepalive timeout in milliseconds */
  GRPC_KEEPALIVE_TIMEOUT: z.coerce.number().int().positive().default(10000), // 10 seconds

  // ============================================================================
  // OpenTelemetry Configuration
  // ============================================================================

  /** Enable OpenTelemetry instrumentation */
  OTEL_ENABLED: z.coerce.boolean().default(true),

  /** OTLP exporter endpoint (HTTP) */
  OTEL_ENDPOINT: z.string().url().default('http://localhost:4318'),

  /** Service name for telemetry */
  OTEL_SERVICE_NAME: z.string().default('consonant-control-plane'),

  /** Service version for telemetry */
  OTEL_SERVICE_VERSION: z.string().default('1.0.0'),

  /** Environment name for telemetry */
  OTEL_ENVIRONMENT: z.string().default('development'),

  // ============================================================================
  // Inngest Configuration
  // ============================================================================

  /** Inngest event key for authentication */
  INNGEST_EVENT_KEY: z.string().default('local'),

  /** Inngest signing key for webhook verification */
  INNGEST_SIGNING_KEY: z.string().optional(),

  /** Inngest app ID */
  INNGEST_APP_ID: z.string().default('consonant-control-plane'),

  // ============================================================================
  // Security Configuration
  // ============================================================================

  /** CORS allowed origins (comma-separated) */
  CORS_ORIGIN: z.string().default('*'),

  /** Bcrypt rounds for password hashing */
  BCRYPT_ROUNDS: z.coerce.number().int().min(10).max(15).default(12),

  // ============================================================================
  // Rate Limiting Configuration
  // ============================================================================

  /** Default rate limit (requests per minute) */
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),

  /** Rate limit window in milliseconds */
  RATE_LIMIT_WINDOW: z.coerce.number().int().positive().default(60000), // 1 minute

  // ============================================================================
  // Feature Flags
  // ============================================================================

  /** Enable API key authentication */
  FEATURE_API_KEYS: z.coerce.boolean().default(true),

  /** Enable cluster authentication */
  FEATURE_CLUSTER_AUTH: z.coerce.boolean().default(true),

  /** Enable telemetry storage */
  FEATURE_TELEMETRY: z.coerce.boolean().default(true),
});

/**
 * Validated environment variables.
 * 
 * This object contains all configuration with proper types.
 * Accessing invalid configuration will throw at startup.
 */
export type Env = z.infer<typeof envSchema>;

/**
 * Parse and validate environment variables.
 * 
 * This function runs at module load time and will throw if
 * any required configuration is missing or invalid.
 * 
 * @throws {z.ZodError} If environment validation fails
 */
function parseEnv(): Env {
  try {
    return envSchema.parse(process.env);
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error('❌ Environment validation failed:');
      console.error(JSON.stringify(error.format(), null, 2));
      process.exit(1);
    }
    throw error;
  }
}

/**
 * Validated and type-safe environment configuration.
 * 
 * Import this throughout the application for configuration access.
 * 
 * @example
 * import { env } from '@/config/env';
 * 
 * const server = new Server({ port: env.PORT });
 */
export const env = parseEnv();

/**
 * Check if running in production environment.
 * 
 * @returns True if NODE_ENV is 'production'
 */
export function isProduction(): boolean {
  return env.NODE_ENV === 'production';
}

/**
 * Check if running in development environment.
 * 
 * @returns True if NODE_ENV is 'development'
 */
export function isDevelopment(): boolean {
  return env.NODE_ENV === 'development';
}

/**
 * Check if running in test environment.
 * 
 * @returns True if NODE_ENV is 'test'
 */
export function isTest(): boolean {
  return env.NODE_ENV === 'test';
}

/**
 * Get database URL with sensitive information masked.
 * Safe to use in logs.
 * 
 * @returns Masked database URL
 */
export function getMaskedDatabaseUrl(): string {
  const url = env.DATABASE_URL;

  // Mask password in URL
  return url.replace(/:[^:@]+@/, ':****@');
}

/**
 * Get all configuration as a safe object for logging.
 * Sensitive fields are masked.
 * 
 * @returns Safe configuration object
 */
export function getSafeConfig(): Record<string, unknown> {
  return {
    NODE_ENV: env.NODE_ENV,
    PORT: env.PORT,
    HOST: env.HOST,
    LOG_LEVEL: env.LOG_LEVEL,
    DATABASE_URL: getMaskedDatabaseUrl(),
    REDIS_URL: env.REDIS_URL.replace(/:[^:@]+@/, ':****@'),
    GRPC_PORT: env.GRPC_PORT,
    GRPC_TLS_ENABLED: env.GRPC_TLS_ENABLED,
    OTEL_ENABLED: env.OTEL_ENABLED,
    OTEL_ENDPOINT: env.OTEL_ENDPOINT,
    OTEL_SERVICE_NAME: env.OTEL_SERVICE_NAME,
  };
}