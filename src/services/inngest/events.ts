/**
 * @fileoverview Inngest event definitions for  Orchestration
 * @module services/inngest/events
 * 
 * @description
 * Event definitions for Inngest events.
 * 
 * @author Consonant Team
 * @version 0.1.0
 */


import { EventSchemas } from 'inngest';

/**
 * Consonant workflow event types
 */
export type ConsonantEvents = {
  // Orchestration control events
};

export const schemas = new EventSchemas().fromRecord<ConsonantEvents>();
