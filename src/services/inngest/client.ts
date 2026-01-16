/**
 * src/inngest/client.ts
 * 
 * Inngest client initialization with properly typed event schemas.
 */

import { Inngest, EventSchemas } from 'inngest';
import { logger } from '../../utils/logger.js';
import { schemas, ConsonantEvents } from './events.js';

// ============================================================================
// CONFIGURATION
// ============================================================================

const INNGEST_EVENT_KEY = process.env.INNGEST_EVENT_KEY || 'local';



// ============================================================================
// INNGEST CLIENT
// ============================================================================

/**
 * Inngest client instance
 * 
 * @description
 * Configured with Consonant-specific event schemas.
 * Use this instance for all event operations.
 */
export const inngest = new Inngest({
  id: 'consonant',
  schemas,
  eventKey: INNGEST_EVENT_KEY,
});

