import Fastify, { FastifyInstance } from "fastify";
import { FastifyErrorHandlerRegister } from "./FastifyErrorHandler";

function createFakeLogger() {
  const logger = {
    child: () => logger,
    trace: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    fatal: jest.fn(),
  };
  return logger;
}

function buildApp(logger?: ReturnType<typeof createFakeLogger>): FastifyInstance {
  const app = (
    logger
      ? Fastify({ loggerInstance: logger as never })
      : Fastify({ logger: false })
  ) as FastifyInstance;
  FastifyErrorHandlerRegister(app);
  app.get("/server-error", async () => {
    const error = new Error("attempt to write a readonly database") as Error & {
      code: string;
    };
    error.code = "SQLITE_READONLY";
    throw error;
  });
  app.get("/client-error", async () => {
    const error = new Error("Missing: Name") as Error & {
      statusCode: number;
      code: string;
    };
    error.statusCode = 400;
    error.code = "FST_ERR_VALIDATION";
    throw error;
  });
  app.get("/unavailable", async () => {
    const error = new Error("connection refused by the database") as Error & {
      statusCode: number;
    };
    error.statusCode = 503;
    throw error;
  });
  app.get("/committed-status", async (_req, reply) => {
    reply.status(404);
    throw new Error("internal lookup failed");
  });
  app.register(async (instance: FastifyInstance) => {
    instance.get("/nested/server-error", async () => {
      throw new Error("nested internal detail");
    });
  });
  return app;
}

describe("FastifyErrorHandlerRegister", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("should hide the error code and message of a 500 response", async () => {
    const response = await app.inject({ method: "GET", url: "/server-error" });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      statusCode: 500,
      error: "Internal Server Error",
      message: "Internal Server Error",
    });
    expect(response.body).not.toContain("SQLITE_READONLY");
    expect(response.body).not.toContain("readonly database");
  });

  it("should hide the error code and message of a 5xx response in nested plugins", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/nested/server-error",
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      statusCode: 500,
      error: "Internal Server Error",
      message: "Internal Server Error",
    });
    expect(response.body).not.toContain("nested internal detail");
  });

  it("should keep the status label for other 5xx responses", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/unavailable",
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      statusCode: 503,
      error: "Service Unavailable",
      message: "Service Unavailable",
    });
    expect(response.body).not.toContain("connection refused");
  });

  it("should keep the message and code of a client error", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/client-error",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      statusCode: 400,
      error: "Bad Request",
      message: "Missing: Name",
      code: "FST_ERR_VALIDATION",
    });
  });

  it("should keep an error status already set on the reply", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/committed-status",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      statusCode: 404,
      error: "Not Found",
      message: "internal lookup failed",
    });
  });

  it("should log the original server error with its details", async () => {
    const logger = createFakeLogger();
    const loggedApp = buildApp(logger);
    await loggedApp.ready();

    const response = await loggedApp.inject({
      method: "GET",
      url: "/server-error",
    });

    expect(response.statusCode).toBe(500);
    expect(logger.error).toHaveBeenCalledWith(
      { err: expect.any(Error) },
      "Request failed",
    );
    const loggedError = logger.error.mock.calls[0][0].err as Error & {
      code?: string;
    };
    expect(loggedError.message).toBe("attempt to write a readonly database");
    expect(loggedError.code).toBe("SQLITE_READONLY");
    await loggedApp.close();
  });
});
