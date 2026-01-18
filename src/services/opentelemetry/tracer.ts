/**
 * @fileoverview OpenTelemetry SDK Initialization
 * @module services/opentelemetry/tracer
 * 
 * Initializes the OpenTelemetry SDK for distributed tracing.
 * This provides automatic instrumentation for HTTP, gRPC, database, and more.
 * 
 * INSTRUMENTATION:
 * - HTTP/HTTPS (Fastify)
 * - gRPC
 * - Prisma (database queries)
 * - Redis
 * - Context propagation via W3C Trace Context
 * 
 * EXPORTERS:
 * - OTLP (OpenTelemetry Protocol) over HTTP
 * - Sends to Jaeger, Tempo, or other OTLP-compatible collectors
 * 
 * IMPORTANT: This file must be imported BEFORE any other modules
 * to ensure instrumentation is applied correctly.
 */

import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
// @ts-ignore
import * as resources from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
// @ts-ignore
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { env } from '@/config/env.js';
import { OTEL } from '@/config/constants.js';
import { internalLogger } from '@/utils/logger.js';

/**
 * Initialize OpenTelemetry SDK.
 * 
 * This creates and configures the global OpenTelemetry SDK instance.
 * It sets up automatic instrumentation, trace exporters, and resource attributes.
 * 
 * @returns Initialized SDK instance
 */
export function initializeOpenTelemetry(): NodeSDK | null {
  if (!env.OTEL_ENABLED) {
    internalLogger.info('OpenTelemetry disabled via configuration');
    return null;
  }

  internalLogger.info('Initializing OpenTelemetry SDK...');

  try {
    // Create trace exporter
    const traceExporter = new OTLPTraceExporter({
      url: `${env.OTEL_ENDPOINT}/v1/traces`,
      headers: {},
    });

    // Create resource attributes
    const resource = resources.Resource.default().merge(
      new resources.Resource({
        [SemanticResourceAttributes.SERVICE_NAME]: env.OTEL_SERVICE_NAME,
        [SemanticResourceAttributes.SERVICE_VERSION]: env.OTEL_SERVICE_VERSION,
        [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]: env.OTEL_ENVIRONMENT,
      })
    );

    // Create SDK instance
    const sdk = new NodeSDK({
      resource,

      // Span processor with batching
      spanProcessor: new BatchSpanProcessor(traceExporter, {
        maxQueueSize: OTEL.BATCH_MAX_QUEUE_SIZE,
        maxExportBatchSize: OTEL.BATCH_MAX_EXPORT_SIZE,
        scheduledDelayMillis: OTEL.BATCH_TIMEOUT_MS,
      }) as any,

      // Automatic instrumentation
      instrumentations: [
        getNodeAutoInstrumentations({
          '@opentelemetry/instrumentation-fs': {
            enabled: false,
          } as any,
          '@opentelemetry/instrumentation-http': {
            enabled: true,
            ignoreIncomingRequestHook: (req: any) => {
              const url = req.url || '';
              return ['/health', '/metrics'].some(path => url.includes(path));
            },
          } as any,
          '@opentelemetry/instrumentation-fastify': {
            enabled: true,
          } as any,
          '@opentelemetry/instrumentation-grpc': {
            enabled: true,
          } as any,
        } as any),
      ],
    });

    // Start the SDK
    sdk.start();

    internalLogger.info('✓ OpenTelemetry SDK initialized successfully');
    internalLogger.info(`✓ Exporting traces to: ${env.OTEL_ENDPOINT}`);

    // Handle graceful shutdown
    process.on('SIGTERM', async () => {
      try {
        await sdk.shutdown();
        internalLogger.info('✓ OpenTelemetry SDK shut down');
      } catch (error) {
        internalLogger.error({ err: error }, 'Error shutting down OpenTelemetry SDK');
      }
    });

    return sdk;

  } catch (error) {
    internalLogger.error({ err: error }, 'Failed to initialize OpenTelemetry SDK');
    return null;
  }
}

/**
 * Get the global OpenTelemetry tracer.
 * 
 * Use this to create custom spans for manual instrumentation.
 * 
 * @returns Tracer instance
 * 
 * @example
 * import { trace } from '@opentelemetry/api';
 * 
 * const tracer = trace.getTracer('my-service');
 * const span = tracer.startSpan('my-operation');
 * 
 * try {
 *   // Do work
 *   span.setStatus({ code: SpanStatusCode.OK });
 * } catch (error) {
 *   span.setStatus({ code: SpanStatusCode.ERROR });
 *   span.recordException(error);
 * } finally {
 *   span.end();
 * }
 */
export { trace } from '@opentelemetry/api';