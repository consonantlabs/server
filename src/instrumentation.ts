/**
 * @fileoverview Application Instrumentation
 * @module instrumentation
 * 
 * This file is responsible for initializing OpenTelemetry BEFORE any other
 * application modules are loaded. This ensures that automatic instrumentation
 * of libraries (like Fastify, Prisma, Redis) works correctly.
 * 
 * IMPORTANCE: This MUST be the first import in server.ts.
 */

import { initializeOpenTelemetry } from './services/opentelemetry/tracer.js';

// Initialize OTEL immediately
initializeOpenTelemetry();
