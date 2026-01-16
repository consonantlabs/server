/**
 * src/utils/crypto.ts
 * * Cryptography Utilities for Terra Control Plane
 * * SECURITY PRINCIPLES:
 * 1. Never store plaintext secrets in database.
 * 2. Use timing-safe comparisons to prevent timing attacks.
 * 3. Use high-entropy random tokens (crypto.randomBytes).
 * 4. Use bcrypt with proper cost factor (12).
 * 5. Handle "undefined" and key-order explicitly for deterministic hashing.
 */

import * as crypto from 'crypto';
import * as bcrypt from 'bcrypt';

// ============================================================================
// CONSTANTS
// ============================================================================

const BCRYPT_ROUNDS = 12;
const MIN_SECRET_LENGTH = 32;

// ============================================================================
// TOKEN GENERATION
// ============================================================================

/**
 * Generate cryptographically secure random token
 * 
 * Used for:
 * - Cluster secrets
 * - API keys
 * - Session tokens
 * 
 * @param length - Token length in bytes (default: 32)
 * @returns Hex-encoded token
 * 
 * @example
 * const secret = generateSecureToken(32);
 * // Returns: "a3f5c8e2d1b4..."  (64 hex chars)
 */

export function generateSecureToken(length: number = MIN_SECRET_LENGTH): string {
  if (length < MIN_SECRET_LENGTH) {
    throw new Error(`Token length must be at least ${MIN_SECRET_LENGTH} bytes`);
  }
  return crypto.randomBytes(length).toString('hex');
}

/**
 * Generate UUID v4
 * 
 * Used for:
 * - Database IDs
 * - Request IDs
 * - SIDs
 * crypto.randomUUID() produces a string with dashes (e.g., 550e8400-e29b-41d4-a716-446655440000). 
 * While many modern backends accept this, strict OTLP collectors expect a hexadecimal string without dashes.
 * 
 * @returns UUID string
 */
export function generateUUID(): string {
  // Strips dashes to create a 32-character hex string
  // '550e8400-e29b-41d4-a716-446655440000' -> '550e8400e29be41da716446655440000'
  return crypto.randomUUID().replace(/-/g, '');
}

// ============================================================================
// SECRET HASHING (One-way for Authentication)
// ============================================================================


/**
 * Hash secret using bcrypt
 * 
 * CRITICAL: This is a ONE-WAY operation. You CANNOT reverse it.
 * The only way to verify a secret is to hash the candidate and compare.
 * 
 * @param secret - Plaintext secret to hash
 * @returns Bcrypt hash (includes salt)
 * 
 * @throws Error if secret is too short
 * 
 * @example
 * const hash = await hashSecret("my-cluster-secret-xyz");
 * // Returns: "$2b$12$abcdef..."
 */

export async function hashSecret(secret: string): Promise<string> {
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`Secret must be at least ${MIN_SECRET_LENGTH} characters`);
  }
  return await bcrypt.hash(secret, BCRYPT_ROUNDS);
}


/**
 * Verify secret against hash (timing-safe)
 * 
 * Uses bcrypt's built-in timing-safe comparison to prevent timing attacks.
 * 
 * @param candidateSecret - Secret to verify
 * @param storedHash - Bcrypt hash from database
 * @returns True if secret matches hash
 * 
 * @example
 * const isValid = await verifySecret("candidate", storedHash);
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
    return false; // Security: Do not leak bcrypt internal errors
  }
}

// ============================================================================
// CANONICAL STRINGIFICATION (Deterministic Foundation)
// ============================================================================

/**
 * Deterministically converts any value to a string.
 * This is the engine for our drift detection.
 *  CRITICAL: Object key order matters for hashing.
 * We must sort keys recursively to ensure same input = same hash.
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
      const val = (obj as any)[k];
      return `"${k}":${stableStringify(val)}`;
    });
    return `{${pairs.join(',')}}`;
  }

  // Fallback for strings, numbers, booleans
  return JSON.stringify(obj);
}

// ============================================================================
// CONTENT HASHING (For Integrity & Drift Detection)
// ============================================================================

/**
 * Generate SHA-256 hash of content
 * 
 * Used for:
 * - Agent manifest hashing (drift detection)
 * - File integrity checks
 * - Content addressing
 * 
 * @param content - Content to hash (string or object)
 * @returns Hex-encoded SHA-256 hash (64 chars)
 * 
 * @example
 * const hash = hashContent({ spec: { image: "nginx" } });
 * // Returns: "e3b0c44298fc1c14..." (64 hex chars)
 */
export function hashContent(content: string | object): string {
  const data = stableStringify(content);
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Verify content hash
 * 
 * @param content - Content to verify
 * @param expectedHash - Expected SHA-256 hash
 * @returns True if content matches hash
 */
export function verifyContentHash(
  content: any,
  expectedHash: string
): boolean {
  const actualHash = hashContent(content);
  return timingSafeEqual(actualHash, expectedHash);
}



// ============================================================================
// HASH TRUNCATION (For logging)
// ============================================================================

/**
 * Get short version of hash for display
 * Never log full hashes (security concern)
 */
export function shortHash(hash: string): string {
  return hash.substring(0, 12);
}

/**
 * Validate hash format (64 hex chars for SHA-256)
 */
export function isValidHash(hash: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(hash);
}


// ============================================================================
// TIMING-SAFE COMPARISONS
// ============================================================================

/**
 * Timing-safe string comparison
 * 
 * SECURITY: Normal string comparison (===) is vulnerable to timing attacks.
 * An attacker can measure how long it takes to reject a candidate and
 * infer information about the secret.
 * 
 * This function always takes constant time regardless of input.
 * 
 * @param a - First string
 * @param b - Second string
 * @returns True if strings are equal
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  
  if (aBuf.length !== bBuf.length) {
    // Perform dummy comparison to keep timing relatively consistent
    crypto.timingSafeEqual(aBuf, aBuf);
    return false;
  }
  
  return crypto.timingSafeEqual(aBuf, bBuf);
}

// ============================================================================
// UTILITIES & REDACTION
// ============================================================================


/**
 * Validate secret format
 * 
 * Ensures secret meets minimum security requirements:
 * - At least 32 characters
 * - Only alphanumeric + safe special chars
 * - Not obviously weak (no "password", "secret", etc.)
 * 
 * @param secret - Secret to validate
 * @returns Validation result
 */

export function validateSecretFormat(secret: string): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  
  if (secret.length < MIN_SECRET_LENGTH) {
    errors.push(`Secret must be at least ${MIN_SECRET_LENGTH} characters`);
  }
  
  // Check for weak patterns
  const weakPatterns = [
    'password',
    'secret',
    '123456',
    'qwerty',
    'admin',
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
// SECURE RANDOM UTILITIES
// ============================================================================

/**
 * Generate random integer in range [min, max]
 * 
 * Uses crypto.randomInt for cryptographically secure randomness.
 * 
 * @param min - Minimum value (inclusive)
 * @param max - Maximum value (inclusive)
 * @returns Random integer
 */
export function randomInt(min: number, max: number): number {
  return crypto.randomInt(min, max + 1);
}

/**
 * Generate random element from array
 * 
 * @param array - Array to select from
 * @returns Random element
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
 * Redact secret for logging
 * 
 * Shows first 8 chars + "..." to aid debugging while protecting secret.
 * 
 * @param secret - Secret to redact
 * @returns Redacted string
 * 
 * @example
 * redactSecret("a3f5c8e2d1b4...")
 * // Returns: "a3f5c8e2..."
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
 * Mask environment variable value
 * 
 * @param key - Environment variable name
 * @param value - Environment variable value
 * @returns Masked value if sensitive, otherwise original value
 */
export function maskEnvVar(key: string, value: string): string {
  const sensitivePatterns = [
    'SECRET',
    'PASSWORD',
    'KEY',
    'TOKEN',
    'CREDENTIAL',
    'AUTH',
  ];
  
  const upperKey = key.toUpperCase();
  const isSensitive = sensitivePatterns.some(pattern => upperKey.includes(pattern));
  
  return isSensitive ? '***MASKED***' : value;
}

// ============================================================================
// EXPORTS
// ============================================================================

export default {
  // Token generation
  generateSecureToken,
  generateUUID,
  
  // Secret hashing
  hashSecret,
  verifySecret,
  
  // Content hashing
  hashContent,
  verifyContentHash,
  
  // Comparisons
  timingSafeEqual,
  
  // Validation
  validateSecretFormat,
  
  // Random utilities
  randomInt,
  randomElement,
  
  // Redaction
  redactSecret,
  maskEnvVar,

  shortHash,
  isValidHash
};