/**
 * @fileoverview Cryptography Utilities
 * @module utils/crypto
 * 
 * Provides cryptographic functions for the control plane including:
 * - Secure token generation (API keys, cluster secrets)
 * - Password/secret hashing with bcrypt
 * - Content hashing for integrity verification
 * - Timing-safe comparisons to prevent timing attacks
 * - UUID generation
 * 
 * SECURITY PRINCIPLES:
 * 1. Never store plaintext secrets in database
 * 2. Use timing-safe comparisons to prevent timing attacks
 * 3. Use high-entropy random tokens (crypto.randomBytes)
 * 4. Use bcrypt with proper cost factor (12)
 * 5. Handle undefined and key-order explicitly for deterministic hashing
 */

import * as crypto from 'crypto';
import * as bcrypt from 'bcrypt';
import { SECURITY } from '@/config/constants.js';

// ============================================================================
// TOKEN GENERATION
// ============================================================================

/**
 * Generate cryptographically secure random token.
 * 
 * Uses Node.js crypto.randomBytes() which provides cryptographically
 * strong pseudo-random data. This is suitable for:
 * - API keys
 * - Cluster secrets
 * - Session tokens
 * - CSRF tokens
 * 
 * @param length - Token length in bytes (default: 32)
 * @returns Hex-encoded token (length * 2 characters)
 * @throws {Error} If length is below minimum (32 bytes)
 * 
 * @example
 * const apiKey = generateSecureToken(32);
 * // Returns: "a3f5c8e2d1b4..." (64 hex characters)
 * 
 * const secret = generateSecureToken(64);
 * // Returns: 128 hex characters
 */
export function generateSecureToken(length: number = SECURITY.MIN_API_KEY_LENGTH): string {
  if (length < SECURITY.MIN_API_KEY_LENGTH) {
    throw new Error(
      `Token length must be at least ${SECURITY.MIN_API_KEY_LENGTH} bytes for security`
    );
  }

  return crypto.randomBytes(length).toString('hex');
}

/**
 * Generate a new API key and its hash.
 * 
 * Returns both the plaintext key (to show once to the user)
 * and the hash (to store in the database).
 * 
 * @returns Object containing apiKey and keyHash
 */
export async function generateApiKey(): Promise<{ apiKey: string; keyHash: string }> {
  // sk_ prefix for identification, followed by 64 chars of entropy
  const apiKey = 'sk_' + generateSecureToken(32);
  const keyHash = await hashSecret(apiKey);
  return { apiKey, keyHash };
}

/**
 * Generate UUID v4 (RFC 4122 compliant).
 * 
 * Uses Node.js crypto.randomUUID() which generates a random UUID.
 * UUIDs are suitable for:
 * - Database primary keys
 * - Request IDs
 * - Trace IDs (when formatted without dashes)
 * 
 * Note: For OpenTelemetry trace IDs, use generateTraceId() instead
 * which returns a 32-character hex string without dashes.
 * 
 * @returns UUID string (format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx)
 * 
 * @example
 * const id = generateUUID();
 * // Returns: "550e8400-e29b-41d4-a716-446655440000"
 */
export function generateUUID(): string {
  return crypto.randomUUID();
}

/**
 * Generate OpenTelemetry-compatible trace ID.
 * 
 * OTLP collectors expect trace IDs as 32-character hexadecimal strings
 * without dashes. This function generates a UUID and strips the dashes.
 * 
 * @returns 32-character hex string
 * 
 * @example
 * const traceId = generateTraceId();
 * // Returns: "550e8400e29b41d4a716446655440000"
 */
export function generateTraceId(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

/**
 * Generate OpenTelemetry-compatible span ID.
 * 
 * Span IDs are 16-character hexadecimal strings (8 bytes).
 * 
 * @returns 16-character hex string
 * 
 * @example
 * const spanId = generateSpanId();
 * // Returns: "a3f5c8e2d1b4e7f0"
 */
export function generateSpanId(): string {
  return crypto.randomBytes(8).toString('hex');
}

// ============================================================================
// SECRET HASHING (One-way for Authentication)
// ============================================================================

/**
 * Hash secret using bcrypt.
 * 
 * CRITICAL: This is a ONE-WAY operation. You CANNOT reverse it.
 * The only way to verify a secret is to hash the candidate and compare.
 * 
 * Bcrypt automatically:
 * - Generates a random salt
 * - Includes the salt in the hash output
 * - Uses configurable cost factor (work factor)
 * 
 * The cost factor (rounds) determines how expensive the hash is to compute.
 * Higher values are more secure but slower. We use 12 which is a good
 * balance for 2025 hardware.
 * 
 * @param secret - Plaintext secret to hash
 * @param rounds - Bcrypt cost factor (default: 12)
 * @returns Bcrypt hash (includes salt, format: $2b$12$...)
 * @throws {Error} If secret is too short
 * 
 * @example
 * const hash = await hashSecret("my-cluster-secret-xyz");
 * // Returns: "$2b$12$abcdef..." (60 characters)
 * 
 * // Store hash in database (NEVER store plaintext)
 * await db.cluster.create({
 *   secretHash: hash,
 * });
 */
export async function hashSecret(
  secret: string,
  rounds: number = SECURITY.BCRYPT_ROUNDS
): Promise<string> {
  if (secret.length < SECURITY.MIN_CLUSTER_SECRET_LENGTH) {
    throw new Error(
      `Secret must be at least ${SECURITY.MIN_CLUSTER_SECRET_LENGTH} characters`
    );
  }

  return await bcrypt.hash(secret, rounds);
}

/**
 * Verify secret against bcrypt hash (timing-safe).
 * 
 * Uses bcrypt's built-in timing-safe comparison to prevent timing attacks.
 * Always takes constant time regardless of where the mismatch occurs.
 * 
 * @param candidateSecret - Secret to verify
 * @param storedHash - Bcrypt hash from database
 * @returns True if secret matches hash
 * 
 * @example
 * // User provides secret during authentication
 * const providedSecret = req.headers['cluster-secret'];
 * 
 * // Fetch stored hash from database
 * const cluster = await db.cluster.findUnique({
 *   where: { id: clusterId },
 * });
 * 
 * // Verify secret
 * const isValid = await verifySecret(providedSecret, cluster.secretHash);
 * if (isValid) {
 *   // Grant access
 * }
 */
export async function verifySecret(
  candidateSecret: string,
  storedHash: string
): Promise<boolean> {
  try {
    return await bcrypt.compare(candidateSecret, storedHash);
  } catch (error) {
    // Security: Do not leak bcrypt internal errors
    // Always return false on error (invalid hash format, etc.)
    return false;
  }
}

// ============================================================================
// CONTENT HASHING (For Integrity & Drift Detection)
// ============================================================================

/**
 * Deterministically convert any value to a string.
 * 
 * This is the foundation for content hashing. Object key order matters
 * for hashing, so we recursively sort keys to ensure consistent output.
 * 
 * Special handling:
 * - null → 'null'
 * - undefined → 'undefined'
 * - Arrays → recursive stringify of elements
 * - Objects → sorted keys with recursive stringify
 * - Primitives → JSON.stringify
 * 
 * @param obj - Value to stringify
 * @returns Deterministic string representation
 */
function stableStringify(obj: unknown): string {
  if (obj === null) return 'null';
  if (obj === undefined) return 'undefined';

  if (Array.isArray(obj)) {
    return `[${obj.map(stableStringify).join(',')}]`;
  }

  if (typeof obj === 'object') {
    // Sort keys to ensure {"a":1, "b":2} always hashes same as {"b":2, "a":1}
    const keys = Object.keys(obj as object).sort();
    const pairs = keys.map(k => {
      const val = (obj as Record<string, unknown>)[k];
      return `"${k}":${stableStringify(val)}`;
    });
    return `{${pairs.join(',')}}`;
  }

  // Fallback for strings, numbers, booleans
  return JSON.stringify(obj);
}

/**
 * Generate SHA-256 hash of content.
 * 
 * Used for:
 * - Agent manifest hashing (drift detection)
 * - File integrity checks
 * - Content addressing
 * - Idempotency keys
 * 
 * The hash is deterministic: same input always produces same hash.
 * Object key order is normalized to ensure consistency.
 * 
 * @param content - Content to hash (string or object)
 * @returns Hex-encoded SHA-256 hash (64 characters)
 * 
 * @example
 * const hash = hashContent({ spec: { image: "nginx" } });
 * // Returns: "e3b0c44298fc1c14..." (64 hex chars)
 * 
 * // Same hash regardless of key order
 * const hash1 = hashContent({ a: 1, b: 2 });
 * const hash2 = hashContent({ b: 2, a: 1 });
 * // hash1 === hash2 (true)
 */
export function hashContent(content: string | object): string {
  const data = typeof content === 'string' ? content : stableStringify(content);
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Verify content against expected hash.
 * 
 * Uses timing-safe comparison to prevent timing attacks.
 * 
 * @param content - Content to verify
 * @param expectedHash - Expected SHA-256 hash
 * @returns True if content matches hash
 * 
 * @example
 * const manifest = { spec: { image: "nginx:1.21" } };
 * const storedHash = "abc123...";
 * 
 * if (verifyContentHash(manifest, storedHash)) {
 *   console.log('Manifest unchanged');
 * } else {
 *   console.log('Manifest drift detected!');
 * }
 */
export function verifyContentHash(
  content: unknown,
  expectedHash: string
): boolean {
  const actualHash = hashContent(content as string | object);
  return timingSafeEqual(actualHash, expectedHash);
}

/**
 * Generate short hash for display purposes.
 * 
 * Never log full hashes as they may be sensitive.
 * This truncates to first 12 characters for readability.
 * 
 * @param hash - Full hash to truncate
 * @returns First 12 characters
 * 
 * @example
 * const fullHash = "a3f5c8e2d1b4e7f0...";
 * const short = shortHash(fullHash);
 * // Returns: "a3f5c8e2d1b4"
 * 
 * logger.info(`Manifest hash: ${short}...`);
 */
export function shortHash(hash: string): string {
  return hash.substring(0, 12);
}

/**
 * Validate SHA-256 hash format.
 * 
 * SHA-256 hashes are always 64 hexadecimal characters.
 * 
 * @param hash - Hash to validate
 * @returns True if valid SHA-256 hash format
 */
export function isValidHash(hash: string): boolean {
  return /^[0-9a-f]{64}$/i.test(hash);
}

// ============================================================================
// TIMING-SAFE COMPARISONS
// ============================================================================

/**
 * Timing-safe string comparison.
 * 
 * SECURITY: Normal string comparison (===) is vulnerable to timing attacks.
 * An attacker can measure how long it takes to reject a candidate and
 * infer information about the secret character by character.
 * 
 * This function always takes constant time regardless of where the
 * mismatch occurs, preventing timing attacks.
 * 
 * How it works:
 * 1. Convert both strings to Buffers
 * 2. Check lengths (perform dummy comparison if different)
 * 3. Use crypto.timingSafeEqual for constant-time comparison
 * 
 * @param a - First string
 * @param b - Second string
 * @returns True if strings are equal
 * 
 * @example
 * // Authenticate API key
 * const providedKey = req.headers['x-api-key'];
 * const storedKey = await getStoredKey();
 * 
 * if (timingSafeEqual(providedKey, storedKey)) {
 *   // Grant access
 * }
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);

  if (aBuf.length !== bBuf.length) {
    // Perform dummy comparison to keep timing relatively consistent
    // This prevents attackers from learning string length via timing
    crypto.timingSafeEqual(aBuf, aBuf);
    return false;
  }

  return crypto.timingSafeEqual(aBuf, bBuf);
}

// ============================================================================
// SECRET VALIDATION
// ============================================================================

/**
 * Validation result for secret format check.
 */
export interface SecretValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validate secret format for security requirements.
 * 
 * Checks:
 * - Minimum length (32 characters)
 * - No weak patterns (password, secret, 123456, etc.)
 * - Sufficient entropy (at least 16 unique characters)
 * 
 * Use this before accepting user-provided secrets to ensure
 * they meet minimum security standards.
 * 
 * @param secret - Secret to validate
 * @returns Validation result with errors if invalid
 * 
 * @example
 * const result = validateSecretFormat(userSecret);
 * if (!result.valid) {
 *   return res.status(400).json({
 *     error: 'Invalid secret',
 *     details: result.errors,
 *   });
 * }
 */
export function validateSecretFormat(secret: string): SecretValidationResult {
  const errors: string[] = [];

  if (secret.length < SECURITY.MIN_CLUSTER_SECRET_LENGTH) {
    errors.push(
      `Secret must be at least ${SECURITY.MIN_CLUSTER_SECRET_LENGTH} characters`
    );
  }

  // Check for weak patterns
  const weakPatterns = [
    'password',
    'secret',
    '123456',
    'qwerty',
    'admin',
    'letmein',
    'welcome',
  ];

  const lowerSecret = secret.toLowerCase();
  for (const pattern of weakPatterns) {
    if (lowerSecret.includes(pattern)) {
      errors.push(`Secret contains weak pattern: ${pattern}`);
    }
  }

  // Ensure sufficient entropy (rough check)
  const uniqueChars = new Set(secret).size;
  if (uniqueChars < 16) {
    errors.push('Secret has insufficient entropy (too few unique characters)');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

// ============================================================================
// RANDOM UTILITIES
// ============================================================================

/**
 * Generate random integer in range [min, max] (inclusive).
 * 
 * Uses crypto.randomInt for cryptographically secure randomness.
 * Suitable for security-sensitive applications.
 * 
 * @param min - Minimum value (inclusive)
 * @param max - Maximum value (inclusive)
 * @returns Random integer
 * 
 * @example
 * const dice = randomInt(1, 6);
 * // Returns: 1, 2, 3, 4, 5, or 6
 */
export function randomInt(min: number, max: number): number {
  return crypto.randomInt(min, max + 1);
}

/**
 * Generate random element from array.
 * 
 * @param array - Array to select from
 * @returns Random element
 * @throws {Error} If array is empty
 * 
 * @example
 * const colors = ['red', 'green', 'blue'];
 * const color = randomElement(colors);
 * // Returns: one of the colors
 */
export function randomElement<T>(array: T[]): T {
  if (array.length === 0) {
    throw new Error('Cannot select from empty array');
  }

  const index = randomInt(0, array.length - 1);
  return array[index];
}

// ============================================================================
// REDACTION UTILITIES
// ============================================================================

/**
 * Redact secret for logging.
 * 
 * Shows first 8 characters + "..." to aid debugging while protecting secret.
 * Never log full secrets as they may end up in log aggregation systems.
 * 
 * @param secret - Secret to redact
 * @returns Redacted string
 * 
 * @example
 * const secret = "a3f5c8e2d1b4e7f0...";
 * logger.info(`Secret: ${redactSecret(secret)}`);
 * // Logs: "Secret: a3f5c8e2..."
 */
export function redactSecret(secret: string | undefined | null): string {
  if (!secret) {
    return '[empty]';
  }

  if (secret.length <= 8) {
    return '***';
  }

  return secret.substring(0, 8) + '...';
}

/**
 * Mask environment variable value for logging.
 * 
 * Automatically detects sensitive variable names and masks their values.
 * Safe to use in logs and error messages.
 * 
 * @param key - Environment variable name
 * @param value - Environment variable value
 * @returns Masked value if sensitive, otherwise original value
 * 
 * @example
 * const vars = {
 *   PORT: '3000',
 *   DATABASE_URL: 'postgresql://...',
 *   API_KEY: 'secret123',
 * };
 * 
 * Object.entries(vars).forEach(([key, value]) => {
 *   console.log(`${key}=${maskEnvVar(key, value)}`);
 * });
 * // Logs:
 * // PORT=3000
 * // DATABASE_URL=***MASKED***
 * // API_KEY=***MASKED***
 */
export function maskEnvVar(key: string, value: string): string {
  const sensitivePatterns = [
    'SECRET',
    'PASSWORD',
    'KEY',
    'TOKEN',
    'CREDENTIAL',
    'AUTH',
    'PRIVATE',
  ];

  const upperKey = key.toUpperCase();
  const isSensitive = sensitivePatterns.some(pattern => upperKey.includes(pattern));

  return isSensitive ? '***MASKED***' : value;
}

/**
 * Redact URL credentials for safe logging.
 * 
 * Masks username and password in connection URLs while preserving
 * the rest of the URL for debugging.
 * 
 * @param url - URL to redact
 * @returns URL with masked credentials
 * 
 * @example
 * const dbUrl = "postgresql://user:pass@localhost:5432/db";
 * const safe = redactUrlCredentials(dbUrl);
 * // Returns: "postgresql://****:****@localhost:5432/db"
 */
export function redactUrlCredentials(url: string): string {
  return url.replace(/([a-z]+:\/\/)([^:]+):([^@]+)@/, '$1****:****@');
}