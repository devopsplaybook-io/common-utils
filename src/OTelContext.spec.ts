import { createOTelContext } from "./OTelContext";
import { OTelRequestSpan } from "@devopsplaybook.io/otel-utils-fastify";

jest.mock("@devopsplaybook.io/otel-utils-fastify", () => ({
  OTelRequestSpan: jest.fn(),
}));

const mockOTelRequestSpan = OTelRequestSpan as jest.MockedFunction<
  typeof OTelRequestSpan
>;

describe("createOTelContext", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

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

  it("OTelRequestSpan delegates to the otel-utils-fastify lookup", () => {
    const ctx = createOTelContext();
    const req = { url: "/api/test" };
    const fakeSpan = { spanId: "123" } as never;
    mockOTelRequestSpan.mockReturnValue(fakeSpan);
    expect(ctx.OTelRequestSpan(req)).toBe(fakeSpan);
    expect(mockOTelRequestSpan).toHaveBeenCalledWith(req);
  });

  it("OTelRequestSpan returns undefined when the library finds no span", () => {
    const ctx = createOTelContext();
    const req = {};
    mockOTelRequestSpan.mockReturnValue(undefined);
    expect(ctx.OTelRequestSpan(req)).toBeUndefined();
    expect(mockOTelRequestSpan).toHaveBeenCalledWith(req);
  });
});
