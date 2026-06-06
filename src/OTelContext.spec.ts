import { createOTelContext } from "./OTelContext";

describe("createOTelContext", () => {
  it("should return an object with all expected methods", () => {
    const ctx = createOTelContext();
    expect(typeof ctx.OTelTracer).toBe("function");
    expect(typeof ctx.OTelSetTracer).toBe("function");
    expect(typeof ctx.OTelMeter).toBe("function");
    expect(typeof ctx.OTelSetMeter).toBe("function");
    expect(typeof ctx.OTelLogger).toBe("function");
    expect(typeof ctx.OTelRequestSpan).toBe("function");
  });

  it("should create a StandardLogger lazily", () => {
    const ctx = createOTelContext();
    const logger = ctx.OTelLogger();
    expect(logger).toBeDefined();
    // Same instance on second call
    expect(ctx.OTelLogger()).toBe(logger);
  });

  it("should store and retrieve tracer via setter/getter", () => {
    const ctx = createOTelContext();
    const fakeTracer = { id: "tracer-1" } as never;
    ctx.OTelSetTracer(fakeTracer);
    expect(ctx.OTelTracer()).toBe(fakeTracer);
  });

  it("should store and retrieve meter via setter/getter", () => {
    const ctx = createOTelContext();
    const fakeMeter = { id: "meter-1" } as never;
    ctx.OTelSetMeter(fakeMeter);
    expect(ctx.OTelMeter()).toBe(fakeMeter);
  });

  it("should isolate contexts from each other", () => {
    const ctx1 = createOTelContext();
    const ctx2 = createOTelContext();
    const fakeTracer1 = { id: "tracer-1" } as never;
    const fakeTracer2 = { id: "tracer-2" } as never;
    ctx1.OTelSetTracer(fakeTracer1);
    ctx2.OTelSetTracer(fakeTracer2);
    expect(ctx1.OTelTracer()).toBe(fakeTracer1);
    expect(ctx2.OTelTracer()).toBe(fakeTracer2);
  });

  it("OTelRequestSpan should return undefined for object without tracerSpanApi", () => {
    const ctx = createOTelContext();
    expect(ctx.OTelRequestSpan({})).toBeUndefined();
  });

  it("OTelRequestSpan should return the span when present", () => {
    const ctx = createOTelContext();
    const fakeSpan = { spanId: "123" } as never;
    const req = { tracerSpanApi: fakeSpan };
    expect(ctx.OTelRequestSpan(req)).toBe(fakeSpan);
  });
});
