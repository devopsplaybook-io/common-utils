import {
  StandardLogger,
  StandardMeter,
  StandardTracer,
} from "@devopsplaybook.io/otel-utils";
import { Span } from "@opentelemetry/sdk-trace-base";

/**
 * Result of {@link createOTelContext}.
 * Holds module-level singletons for the OpenTelemetry tracer, meter and logger
 * used throughout a server process.
 */
export interface OTelContext {
  OTelTracer: () => StandardTracer;
  OTelSetTracer: (tracer: StandardTracer) => void;
  OTelMeter: () => StandardMeter;
  OTelSetMeter: (meter: StandardMeter) => void;
  OTelLogger: () => StandardLogger;
  /**
   * Retrieves the span previously attached to a request object.
   * Equivalent to `req.tracerSpanApi`.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  OTelRequestSpan: (req: any) => Span | undefined;
}

/**
 * Creates an isolated OTel context (tracer / meter / logger singletons).
 *
 * Each server process should call this once at startup and pass the returned
 * object to modules that need telemetry access.  This avoids polluting the
 * global module scope and makes unit-testing straightforward.
 *
 * @example
 * ```ts
 * const otel = createOTelContext();
 * otel.OTelSetTracer(new StandardTracer(config));
 * otel.OTelSetMeter(new StandardMeter(config));
 * otel.OTelLogger().initOTel(config);
 * ```
 */
export function createOTelContext(): OTelContext {
  let tracer: StandardTracer;
  let meter: StandardMeter;
  let logger: StandardLogger;

  return {
    OTelTracer: () => tracer,
    OTelSetTracer: (t: StandardTracer) => {
      tracer = t;
    },
    OTelMeter: () => meter,
    OTelSetMeter: (m: StandardMeter) => {
      meter = m;
    },
    OTelLogger: () => {
      if (!logger) {
        logger = new StandardLogger();
      }
      return logger;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    OTelRequestSpan: (req: any) => req?.tracerSpanApi as Span | undefined,
  };
}
