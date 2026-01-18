/**
 * @fileoverview Inngest Functions Registry
 * @module services/inngest/functions/registry
 * 
 * Central registry of all Inngest functions.
 * Import this to register all functions with the Inngest server.
 */

import {
  processTelemetryTraceBatch,
  processTelemetryMetricBatch,
  processTelemetryLogBatch,
} from './telemetry-batch.js';

import {
  handleClusterConnected,
  handleClusterDisconnected,
  handleClusterHeartbeat,
  handleClusterError,
  monitorClusterHealth,
} from './cluster-lifecycle.js';

import {
  processRequestTimeline,
  aggregateRequestTimelines,
} from './request-timeline.js';

import {
  executionWorkflow,
  executionFailureHandler,
} from './execution-workflow.js';

import { registrationWorkflow } from './registration-workflow.js';

/**
 * Array of all Inngest functions.
 * 
 * This is used by the Inngest serve handler to register
 * all functions with the Inngest server.
 * 
 * Add new functions here as you create them.
 */
export const allFunctions = [
  // Telemetry processing
  processTelemetryTraceBatch,
  processTelemetryMetricBatch,
  processTelemetryLogBatch,

  // Cluster lifecycle
  handleClusterConnected,
  handleClusterDisconnected,
  handleClusterHeartbeat,
  handleClusterError,
  monitorClusterHealth,

  // Request timeline tracking
  processRequestTimeline,
  aggregateRequestTimelines,

  // Agent execution
  executionWorkflow,
  executionFailureHandler,
  registrationWorkflow,
];

/**
 * Export individual functions for testing.
 */
export {
  // Telemetry
  processTelemetryTraceBatch,
  processTelemetryMetricBatch,
  processTelemetryLogBatch,

  // Cluster lifecycle
  handleClusterConnected,
  handleClusterDisconnected,
  handleClusterHeartbeat,
  handleClusterError,
  monitorClusterHealth,
};