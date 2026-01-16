// src/db/commands.ts
import { spawn } from 'child_process';
import type { CommandResult, AppLogger } from './types.js';

/** Default timeout for Prisma commands (2 minutes) */
const DEFAULT_TIMEOUT = 120000;

/** Timeout for force-kill after SIGTERM (5 seconds) */
const FORCE_KILL_TIMEOUT = 5000;

/**
 * Runs a Prisma command via npm script.
 * 
 * **How it works:**
 * - Spawns `npm run <command>` as a child process
 * - Captures stdout and stderr
 * - Logs output in real-time
 * - Handles timeouts with graceful SIGTERM → SIGKILL
 * - Returns structured result with success status
 * 
 * **Available commands** (defined in package.json):
 * - `prisma:generate` - Generate Prisma Client
 * - `prisma:migrate` - Run migrations in development
 * - `prisma:migrate:deploy` - Deploy migrations in production
 * - `prisma:reset` - Reset database
 * - `prisma:studio` - Open Prisma Studio
 * - `prisma:push` - Push schema to database without migrations
 * 
 * @param command - npm script name from package.json
 * @param logger - Logger instance for output
 * @param args - Additional arguments to pass to the command
 * @param timeout - Command timeout in milliseconds (default: 120000)
 * @returns Command execution result with output and status
 * 
 * @example
 * ```typescript
 * // Generate Prisma client
 * const result = await runPrismaCommand('prisma:generate', logger);
 * 
 * // Run migration with name
 * const result = await runPrismaCommand(
 *   'prisma:migrate',
 *   logger,
 *   ['--name', 'add_users_table']
 * );
 * 
 * if (result.success) {
 *   console.log('Migration successful!');
 * }
 * ```
 */
export async function runPrismaCommand(
  command: string,
  logger: AppLogger,
  args: string[] = [],
  timeout: number = DEFAULT_TIMEOUT
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const output: string[] = [];
    const errors: string[] = [];

    logger.info(`[Prisma CLI] Running: npm run ${command} ${args.join(' ')}`);

    // Spawn npm process
    const proc = spawn('npm', ['run', command, '--', ...args], {
      cwd: process.cwd(),
      env: { ...process.env },
      shell: true,
    });

    // Set up timeout handling
    const timer = setupTimeout(proc, timeout, logger);

    // Capture stdout
    proc.stdout?.on('data', (data) => {
      const lines = data.toString().split('\n').filter(Boolean);
      output.push(...lines);
      lines.forEach((line: string) => logger.info(`[Prisma CLI] ${line}`));
    });

    // Capture stderr
    proc.stderr?.on('data', (data) => {
      const lines = data.toString().split('\n').filter(Boolean);
      errors.push(...lines);
      lines.forEach((line: string) => logger.info(`[Prisma CLI] ${line}`));
    });

    // Handle completion
    proc.on('close', (code) => {
      clearTimeout(timer);

      const result: CommandResult = {
        success: code === 0,
        output,
        errors,
        exitCode: code,
      };

      if (code === 0) {
        logger.info('[Prisma CLI] ✓ Command completed successfully');
      } else {
        logger.error(`[Prisma CLI] ❌ Command failed with exit code ${code}`);
      }

      resolve(result);
    });

    // Handle errors
    proc.on('error', (error) => {
      clearTimeout(timer);
      errors.push(error.message);
      logger.error(`[Prisma CLI] ❌ Process error: ${error.message}`);

      resolve({
        success: false,
        output,
        errors,
        exitCode: null,
      });
    });
  });
}

/**
 * Sets up timeout handler for a spawned process.
 * 
 * - Sends SIGTERM after timeout
 * - Sends SIGKILL 5 seconds later if still running
 * 
 * @param proc - Child process
 * @param timeout - Timeout in milliseconds
 * @param logger - Logger instance
 * @returns Timer handle
 */
function setupTimeout(
  proc: ReturnType<typeof spawn>,
  timeout: number,
  logger: AppLogger
): NodeJS.Timeout {
  return setTimeout(() => {
    logger.warn(`[Prisma CLI] ⚠ Command timed out after ${timeout}ms`);
    proc.kill('SIGTERM');

    // Force kill after 5 seconds if still running
    setTimeout(() => {
      if (!proc.killed) {
        logger.error('[Prisma CLI] ❌ Force killing process with SIGKILL');
        proc.kill('SIGKILL');
      }
    }, FORCE_KILL_TIMEOUT);
  }, timeout);
}

/**
 * Generate Prisma client.
 * 
 * **What it does:**
 * - Reads schema.prisma
 * - Generates TypeScript types
 * - Creates Prisma Client code
 * - Prepares for database operations
 * 
 * **When to use:**
 * - After changing schema.prisma
 * - After pulling schema from database
 * - During initial project setup
 * 
 * @param logger - Logger instance
 * @returns Command result
 * 
 * @example
 * ```typescript
 * const result = await generatePrismaClient(logger);
 * if (result.success) {
 *   console.log('Client generated successfully');
 * }
 * ```
 */
export async function generatePrismaClient(logger: AppLogger): Promise<CommandResult> {
  logger.info('[Prisma CLI] Generating Prisma client...');
  return runPrismaCommand('prisma:generate', logger);
}

/**
 * Run database migrations in development.
 * 
 * **What it does:**
 * - Creates new migration files
 * - Applies migration to database
 * - Updates schema state
 * 
 * **Note:** Use `deployMigrations()` in production instead.
 * 
 * @param logger - Logger instance
 * @param migrationName - Optional migration name (e.g., 'add_users_table')
 * @returns Command result
 * 
 * @example
 * ```typescript
 * // Create named migration
 * await runMigrations(logger, 'add_users_table');
 * 
 * // Create auto-named migration
 * await runMigrations(logger);
 * ```
 */
export async function runMigrations(
  logger: AppLogger,
  migrationName?: string
): Promise<CommandResult> {
  logger.info('[Prisma CLI] Running database migrations...');
  const args = migrationName ? ['--name', migrationName] : [];
  return runPrismaCommand('prisma:migrate', logger, args);
}

/**
 * Deploy migrations in production.
 * 
 * **What it does:**
 * - Applies pending migrations to database
 * - Does NOT create new migration files
 * - Safe for production use
 * 
 * **Important:** Run this in production deployment pipeline.
 * 
 * @param logger - Logger instance
 * @returns Command result
 * 
 * @example
 * ```typescript
 * // In production startup
 * const result = await deployMigrations(logger);
 * if (!result.success) {
 *   throw new Error('Migration deployment failed');
 * }
 * ```
 */
export async function deployMigrations(logger: AppLogger): Promise<CommandResult> {
  logger.info('[Prisma CLI] Deploying migrations...');
  return runPrismaCommand('prisma:migrate:deploy', logger);
}

/**
 * Reset database (DELETE ALL DATA).
 * 
 * **⚠ DANGER:** This drops the database, recreates it, and runs all migrations.
 * ALL DATA IS PERMANENTLY DELETED.
 * 
 * **Use cases:**
 * - Development environment reset
 * - Test database cleanup
 * - Recovering from failed migrations
 * 
 * **Never use in production!**
 * 
 * @param logger - Logger instance
 * @returns Command result
 * 
 * @example
 * ```typescript
 * if (process.env.NODE_ENV === 'development') {
 *   await resetDatabase(logger);
 * }
 * ```
 */
export async function resetDatabase(logger: AppLogger): Promise<CommandResult> {
  logger.warn('[Prisma CLI] ⚠ Resetting database (ALL DATA WILL BE DELETED)...');
  return runPrismaCommand('prisma:reset', logger, ['--force']);
}

/**
 * Push schema changes to database without migrations.
 * 
 * **What it does:**
 * - Syncs schema.prisma directly to database
 * - No migration files created
 * - Useful for prototyping
 * 
 * **⚠ Warning:** Can cause data loss if schema changes are destructive.
 * 
 * **Use `runMigrations()` in production.**
 * 
 * @param logger - Logger instance
 * @param acceptDataLoss - Accept potential data loss (default: false)
 * @returns Command result
 * 
 * @example
 * ```typescript
 * // Safe push (will prompt if data loss)
 * await pushSchema(logger);
 * 
 * // Force push (accept data loss)
 * await pushSchema(logger, true);
 * ```
 */
export async function pushSchema(
  logger: AppLogger,
  acceptDataLoss: boolean = false
): Promise<CommandResult> {
  logger.info('[Prisma CLI] Pushing schema to database...');
  const args = acceptDataLoss ? ['--accept-data-loss'] : [];
  return runPrismaCommand('prisma:push', logger, args);
}

/**
 * Open Prisma Studio (database GUI).
 * 
 * **What it does:**
 * - Starts local web server
 * - Opens database GUI in browser
 * - Allows viewing/editing data
 * 
 * **Note:** This is a long-running process - it won't return until stopped.
 * 
 * @param logger - Logger instance
 * @param port - Port to run Studio on (default: 5555)
 * @returns Command result (when Studio is closed)
 * 
 * @example
 * ```typescript
 * // Open Studio on default port
 * await openStudio(logger);
 * 
 * // Open Studio on custom port
 * await openStudio(logger, 3000);
 * ```
 */
export async function openStudio(
  logger: AppLogger,
  port?: number
): Promise<CommandResult> {
  logger.info('[Prisma CLI] Opening Prisma Studio...');
  const args = port ? ['--port', port.toString()] : [];
  return runPrismaCommand('prisma:studio', logger, args);
}

/**
 * Validate schema.prisma file.
 * 
 * **What it does:**
 * - Checks schema syntax
 * - Validates field types
 * - Verifies relations
 * 
 * **Use this before committing schema changes.**
 * 
 * @param logger - Logger instance
 * @returns Command result
 * 
 * @example
 * ```typescript
 * const result = await validateSchema(logger);
 * if (!result.success) {
 *   console.error('Schema has errors!');
 * }
 * ```
 */
export async function validateSchema(logger: AppLogger): Promise<CommandResult> {
  logger.info('[Prisma CLI] Validating schema...');
  return runPrismaCommand('prisma:validate', logger);
}

/**
 * Pull database schema into schema.prisma.
 * 
 * **What it does:**
 * - Introspects existing database
 * - Generates schema.prisma from actual database structure
 * - Useful for brownfield projects
 * 
 * **⚠ Warning:** This overwrites your schema.prisma file.
 * 
 * @param logger - Logger instance
 * @returns Command result
 * 
 * @example
 * ```typescript
 * // Pull schema from existing database
 * await pullSchema(logger);
 * ```
 */
export async function pullSchema(logger: AppLogger): Promise<CommandResult> {
  logger.info('[Prisma CLI] Pulling schema from database...');
  return runPrismaCommand('prisma:pull', logger);
}