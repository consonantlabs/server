/**
 * Prisma Provider Sync Script
 * 
 * This script automatically detects the database provider from DATABASE_URL
 * and updates the schema.prisma file accordingly.
 * 
 * WHY THIS IS NEEDED:
 * - Prisma requires the provider to be specified in schema.prisma
 * - We support multiple databases (PostgreSQL, SQLite)
 * - We want to detect the provider at runtime from DATABASE_URL
 * - This allows the same codebase to work with different databases
 * 
 * WHEN IT RUNS:
 * - Before every Prisma command (generate, migrate, etc.)
 * - Automatically via npm scripts
 * - Can be run manually: node prisma/sync-provider.js
 * 
 * WHAT IT DOES:
 * 1. Reads DATABASE_URL from environment
 * 2. Detects provider (postgresql, sqlite)
 * 3. Updates provider field in schema.prisma
 * 4. Preserves all other schema content
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';

// Fix for __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
config({ path: path.join(__dirname, '../.env') });

const SCHEMA_PATH = path.join(__dirname, 'schema.prisma');

/**
 * Detect database provider from DATABASE_URL.
 * 
 * @returns {string} Provider name ('postgresql' or 'sqlite')
 */
export function detectProvider() {
  const dbUrl = process.env.DATABASE_URL || '';
  
  if (!dbUrl || dbUrl.trim() === '') {
    const env = process.env.NODE_ENV || 'development';
    if (env === 'production') {
      throw new Error('DATABASE_URL is required in production');
    }
    console.log('[Prisma Sync] No DATABASE_URL, defaulting to sqlite');
    return 'sqlite';
  }

  if (dbUrl.startsWith('file:')) {
    return 'sqlite';
  }
  
  if (dbUrl.startsWith('postgresql://') || dbUrl.startsWith('postgres://')) {
    return 'postgresql';
  }
  
  console.warn(`[Prisma Sync] Unknown DATABASE_URL format, defaulting to sqlite`);
  return 'sqlite';
}

/**
 * Rewrite schema.prisma with detected provider.
 */
export function syncSchema() {
  console.log('[Prisma Sync] 🚀 Syncing provider...');
  
  try {
    const provider = detectProvider();
    console.log(`[Prisma Sync] Detected provider: ${provider}`);

    if (!fs.existsSync(SCHEMA_PATH)) {
      throw new Error(`Schema file not found: ${SCHEMA_PATH}`);
    }

    let schema = fs.readFileSync(SCHEMA_PATH, 'utf-8');

    // Replace provider in datasource block
    const regex = /(datasource\s+db\s*\{[^}]*provider\s*=\s*")([^"]+)(")/s;
    
    const newSchema = schema.replace(regex, (match, prefix, oldProvider, suffix) => {
      if (oldProvider === provider) {
        console.log(`[Prisma Sync] Provider already "${provider}", no changes needed`);
        return match;
      }
      
      console.log(`[Prisma Sync] Updating provider: "${oldProvider}" → "${provider}"`);
      return `${prefix}${provider}${suffix}`;
    });

    fs.writeFileSync(SCHEMA_PATH, newSchema, 'utf-8');

    console.log('[Prisma Sync] ✓ Schema synced successfully');
    return { success: true, provider };
    
  } catch (error) {
    console.error(`[Prisma Sync] ❌ Error: ${error.message}`);
    process.exit(1);
  }
}

// Run if called directly
if (process.argv[1] === __filename) {
  syncSchema();
}