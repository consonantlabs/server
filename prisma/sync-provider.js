import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { config } from "dotenv";

// Fix for __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

config({ path: path.join(__dirname, '../.env') });

const SCHEMA_PATH = path.join(__dirname, 'schema.prisma');

/**
 * Detect database provider from DATABASE_URL
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
  
  if (dbUrl.startsWith('mysql://')) {
    return 'mysql';
  }

  console.warn(`[Prisma Sync] Unknown DATABASE_URL format, defaulting to sqlite`);
  return 'sqlite';
}

/**
 * Rewrite schema.prisma with detected provider
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

// Logic to run if called directly via 'node prisma/sync-provider.js'
if (process.argv[1] === __filename) {
  syncSchema();
}