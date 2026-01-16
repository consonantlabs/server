import pino from 'pino';
import { contextManager } from './context.js'; // Import your contextManager

const IS_PROD = process.env.NODE_ENV === 'production';

export const logger = pino({
  level: IS_PROD ? 'info' : 'debug',
  // MIXIN: This runs on every log line automatically
  mixin() {
    const context = contextManager.getAllContext();
    // If we are outside a request context (like at startup), return nothing
    if (!context) return {};
    
    // Every log line will now include these fields automatically
    return {
      traceId: context.traceId,
      requestId: context.requestId,
      clusterId: context.clusterId,
      agentRunId: context.agentRunId
      // Note: We don't add 'message' or 'time' here, pino does that.
    };
  },
  transport: !IS_PROD
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss Z',
          ignore: 'pid,hostname',
        },
      }
    : undefined,
});


/**
 * FIXED: Internal logger for the TelemetryRouter to prevent infinite loops.
 * This logger does NOT have the mixin, so it won't try to access context 
 * or trigger more telemetry events if the network fails.
 */
export const internalLogger = pino({ level: 'info' });