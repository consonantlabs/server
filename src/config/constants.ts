/**
 * @fileoverview Application Constants
 * @module config/constants
 * 
 * Defines all application-wide constants including API versions,
 * service names, default values, and magic numbers.
 */

/**
 * API version constants.
 */
export const API_VERSION = {
  V1: 'v1',
  CURRENT: 'v1',
} as const;

/**
 * API base paths.
 */
export const API_PATHS = {
  V1: '/api/v1',
  HEALTH: '/health',
  HEALTH_DB: '/health/db',
  METRICS: '/metrics',
  INNGEST: '/api/inngest',
} as const;

/**
 * Service identifiers.
 */
export const SERVICES = {
  CONTROL_PLANE: 'consonant-control-plane',
  GRPC_SERVER: 'consonant-grpc-server',
  API_SERVER: 'consonant-api-server',
} as const;

/**
 * Domain configuration.
 */
export const DOMAIN = {
  PRIMARY: 'consonantlabs.xyz',
  API_BASE: 'https://consonantlabs.xyz/api/v1',
  GRPC_BASE: 'grpc://consonantlabs.xyz',
} as const;

/**
 * Security constants.
 */
export const SECURITY = {
  /** Minimum API key length in bytes */
  MIN_API_KEY_LENGTH: 32,
  
  /** Minimum cluster secret length in bytes */
  MIN_CLUSTER_SECRET_LENGTH: 32,
  
  /** Bcrypt cost factor (default if not in env) */
  BCRYPT_ROUNDS: 12,
  
  /** API key expiration (default: 1 year) */
  API_KEY_DEFAULT_EXPIRATION: 365 * 24 * 60 * 60 * 1000,
  
  /** Session timeout in milliseconds */
  SESSION_TIMEOUT: 24 * 60 * 60 * 1000, // 24 hours
} as const;

/**
 * Rate limiting configuration.
 */
export const RATE_LIMITS = {
  /** Default requests per minute for API keys */
  API_KEY_DEFAULT: 100,
  
  /** Requests per minute for unauthenticated requests */
  ANONYMOUS: 10,
  
  /** Requests per minute for health checks */
  HEALTH: 1000,
  
  /** Sliding window duration in milliseconds */
  WINDOW_MS: 60000, // 1 minute
} as const;

/**
 * gRPC connection configuration.
 */
export const GRPC = {
  /** Maximum concurrent streams per connection */
  MAX_CONCURRENT_STREAMS: 100,
  
  /** Connection age before forced reconnection */
  MAX_CONNECTION_AGE_MS: 3600000, // 1 hour
  
  /** Idle timeout before connection closes */
  MAX_CONNECTION_IDLE_MS: 300000, // 5 minutes
  
  /** Keepalive ping interval */
  KEEPALIVE_TIME_MS: 30000, // 30 seconds
  
  /** Keepalive timeout */
  KEEPALIVE_TIMEOUT_MS: 10000, // 10 seconds
  
  /** Heartbeat interval from clients */
  HEARTBEAT_INTERVAL_MS: 15000, // 15 seconds
  
  /** Maximum time without heartbeat before disconnect */
  HEARTBEAT_TIMEOUT_MS: 60000, // 1 minute
} as const;

/**
 * Database configuration.
 */
export const DATABASE = {
  /** Connection pool size */
  POOL_SIZE: 20,
  
  /** Connection timeout in milliseconds */
  CONNECTION_TIMEOUT_MS: 10000,
  
  /** Idle timeout in milliseconds */
  IDLE_TIMEOUT_MS: 30000,
  
  /** Maximum retry attempts for connection */
  MAX_RETRIES: 5,
  
  /** Initial retry delay in milliseconds */
  RETRY_DELAY_MS: 1000,
  
  /** Maximum retry delay in milliseconds */
  MAX_RETRY_DELAY_MS: 30000,
} as const;

/**
 * Time-series data retention policies.
 */
export const RETENTION = {
  /** Trace retention in days */
  TRACES_DAYS: 30,
  
  /** Metric retention in days */
  METRICS_DAYS: 90,
  
  /** Log retention in days */
  LOGS_DAYS: 7,
  
  /** High-resolution metric retention in days */
  METRICS_HIGH_RES_DAYS: 7,
  
  /** Aggregated metric retention in days */
  METRICS_AGGREGATED_DAYS: 365,
} as const;

/**
 * Telemetry batch sizes and intervals.
 */
export const TELEMETRY = {
  /** Maximum batch size for trace ingestion */
  TRACE_BATCH_SIZE: 1000,
  
  /** Maximum batch size for metric ingestion */
  METRIC_BATCH_SIZE: 5000,
  
  /** Maximum batch size for log ingestion */
  LOG_BATCH_SIZE: 10000,
  
  /** Flush interval in milliseconds */
  FLUSH_INTERVAL_MS: 5000,
  
  /** Maximum buffer size before forced flush */
  MAX_BUFFER_SIZE: 50000,
} as const;

/**
 * OpenTelemetry configuration.
 */
export const OTEL = {
  /** Trace sampling rate (1.0 = 100%) */
  TRACE_SAMPLING_RATE: 1.0,
  
  /** Maximum span attributes */
  MAX_SPAN_ATTRIBUTES: 128,
  
  /** Maximum span events */
  MAX_SPAN_EVENTS: 128,
  
  /** Maximum span links */
  MAX_SPAN_LINKS: 128,
  
  /** Batch span processor timeout */
  BATCH_TIMEOUT_MS: 5000,
  
  /** Maximum batch size */
  BATCH_MAX_QUEUE_SIZE: 2048,
  
  /** Maximum export batch size */
  BATCH_MAX_EXPORT_SIZE: 512,
} as const;

/**
 * Inngest configuration.
 */
export const INNGEST = {
  /** Maximum function timeout in milliseconds */
  FUNCTION_TIMEOUT_MS: 300000, // 5 minutes
  
  /** Maximum retries for failed functions */
  MAX_RETRIES: 3,
  
  /** Initial retry delay in milliseconds */
  RETRY_DELAY_MS: 1000,
  
  /** Maximum retry delay in milliseconds */
  MAX_RETRY_DELAY_MS: 60000,
  
  /** Batch processing size */
  BATCH_SIZE: 100,
} as const;

/**
 * HTTP timeouts.
 */
export const TIMEOUTS = {
  /** Default request timeout */
  REQUEST_MS: 30000,
  
  /** Long-running request timeout */
  LONG_REQUEST_MS: 120000,
  
  /** Health check timeout */
  HEALTH_CHECK_MS: 5000,
  
  /** Shutdown grace period */
  SHUTDOWN_MS: 10000,
} as const;

/**
 * Pagination defaults.
 */
export const PAGINATION = {
  /** Default page size */
  DEFAULT_LIMIT: 50,
  
  /** Maximum page size */
  MAX_LIMIT: 1000,
  
  /** Default offset */
  DEFAULT_OFFSET: 0,
} as const;

/**
 * HTTP status codes.
 */
export const HTTP_STATUS = {
  OK: 200,
  CREATED: 201,
  NO_CONTENT: 204,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE_ENTITY: 422,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
} as const;

/**
 * Event types for Inngest.
 */
export const EVENT_TYPES = {
  // Telemetry events
  TELEMETRY_TRACE_BATCH: 'telemetry.trace.batch',
  TELEMETRY_METRIC_BATCH: 'telemetry.metric.batch',
  TELEMETRY_LOG_BATCH: 'telemetry.log.batch',
  
  // Cluster events
  CLUSTER_CONNECTED: 'cluster.connected',
  CLUSTER_DISCONNECTED: 'cluster.disconnected',
  CLUSTER_HEARTBEAT: 'cluster.heartbeat',
  CLUSTER_ERROR: 'cluster.error',
  
  // API key events
  API_KEY_CREATED: 'apikey.created',
  API_KEY_ROTATED: 'apikey.rotated',
  API_KEY_REVOKED: 'apikey.revoked',
  API_KEY_EXPIRED: 'apikey.expired',
  
  // Organization events
  ORG_CREATED: 'organization.created',
  ORG_MEMBER_ADDED: 'organization.member.added',
  ORG_MEMBER_REMOVED: 'organization.member.removed',
  
  // System events
  RETENTION_CLEANUP: 'system.retention.cleanup',
  AGGREGATION: 'system.aggregation',
} as const;

/**
 * Redis key prefixes.
 */
export const REDIS_KEYS = {
  RATE_LIMIT: 'ratelimit',
  SESSION: 'session',
  CACHE: 'cache',
  LOCK: 'lock',
  CLUSTER_CONNECTION: 'cluster:conn',
  API_KEY_USAGE: 'apikey:usage',
} as const;

/**
 * Log levels.
 */
export const LOG_LEVELS = {
  TRACE: 'trace',
  DEBUG: 'debug',
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'error',
  FATAL: 'fatal',
} as const;

/**
 * Cluster statuses.
 */
export const CLUSTER_STATUS = {
  PENDING: 'PENDING',
  ACTIVE: 'ACTIVE',
  INACTIVE: 'INACTIVE',
  FAILED: 'FAILED',
} as const;

/**
 * Organization roles.
 */
export const ORG_ROLES = {
  OWNER: 'OWNER',
  ADMIN: 'ADMIN',
  MEMBER: 'MEMBER',
  VIEWER: 'VIEWER',
} as const;

/**
 * Span kinds for OpenTelemetry.
 */
export const SPAN_KINDS = {
  INTERNAL: 'INTERNAL',
  SERVER: 'SERVER',
  CLIENT: 'CLIENT',
  PRODUCER: 'PRODUCER',
  CONSUMER: 'CONSUMER',
} as const;

/**
 * Metric types.
 */
export const METRIC_TYPES = {
  GAUGE: 'GAUGE',
  COUNTER: 'COUNTER',
  HISTOGRAM: 'HISTOGRAM',
  SUMMARY: 'SUMMARY',
} as const;

/**
 * Log severity levels.
 */
export const LOG_SEVERITY = {
  TRACE: 'TRACE',
  DEBUG: 'DEBUG',
  INFO: 'INFO',
  WARN: 'WARN',
  ERROR: 'ERROR',
  FATAL: 'FATAL',
} as const;