jest.mock("axios", () => ({
  create: jest.fn(),
  isAxiosError: (err: unknown) =>
    typeof err === "object" &&
    err !== null &&
    (err as { isAxiosError?: boolean }).isAxiosError === true,
}));

import axios from "axios";
import {
  NotificationsClient,
  NotificationsLogger,
} from "./Notifications";

const mockedCreate = axios.create as jest.MockedFunction<
  typeof axios.create
>;

/** Logger double that records every call. */
function createMockLogger(): NotificationsLogger & {
  info: jest.Mock;
  warn: jest.Mock;
  error: jest.Mock;
} {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

describe("NotificationsClient", () => {
  let mockPost: jest.Mock;
  let mockLogger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPost = jest.fn();
    mockedCreate.mockReturnValue({ post: mockPost } as never);
    mockLogger = createMockLogger();
  });

  describe("constructor", () => {
    it("should be enabled when apiEndpoint and apiToken are set", () => {
      const client = new NotificationsClient({
        apiEndpoint: "http://localhost/api/notifications",
        apiToken: "token",
        logger: mockLogger,
      });

      expect(client.isEnabled()).toBe(true);
      expect(mockedCreate).toHaveBeenCalledTimes(1);
    });

    it("should be disabled when apiEndpoint is empty", () => {
      const client = new NotificationsClient({
        apiEndpoint: "",
        apiToken: "token",
        logger: mockLogger,
      });

      expect(client.isEnabled()).toBe(false);
      expect(mockedCreate).not.toHaveBeenCalled();
    });

    it("should be disabled when apiToken is empty", () => {
      const client = new NotificationsClient({
        apiEndpoint: "http://localhost/api/notifications",
        apiToken: "",
        logger: mockLogger,
      });

      expect(client.isEnabled()).toBe(false);
      expect(mockedCreate).not.toHaveBeenCalled();
    });

    it("should log the enabled status exactly once at construction", () => {
      new NotificationsClient({
        apiEndpoint: "http://localhost/api/notifications",
        apiToken: "token",
        logger: mockLogger,
      });

      expect(mockLogger.info).toHaveBeenCalledTimes(1);
      expect(mockLogger.info).toHaveBeenCalledWith(
        "Notifications integration enabled",
      );
    });

    it("should log the disabled status exactly once at construction", () => {
      new NotificationsClient({
        apiEndpoint: "",
        apiToken: "",
        logger: mockLogger,
      });

      expect(mockLogger.info).toHaveBeenCalledTimes(1);
      expect(mockLogger.info).toHaveBeenCalledWith(
        "Notifications integration disabled (apiEndpoint or apiToken not set)",
      );
    });

    it("should fall back to console logging when no logger is provided", () => {
      const logSpy = jest.spyOn(console, "log").mockImplementation(jest.fn());

      const client = new NotificationsClient({
        apiEndpoint: "http://localhost/api/notifications",
        apiToken: "token",
      });

      expect(client.isEnabled()).toBe(true);
      expect(logSpy).toHaveBeenCalledWith(
        "Notifications integration enabled",
      );

      logSpy.mockRestore();
    });

    it("should default the request timeout to 10000 ms", () => {
      new NotificationsClient({
        apiEndpoint: "http://localhost/api/notifications",
        apiToken: "token",
        logger: mockLogger,
      });

      expect(mockedCreate).toHaveBeenCalledWith(
        expect.objectContaining({ timeout: 10000 }),
      );
    });

    it("should honor a custom request timeout", () => {
      new NotificationsClient({
        apiEndpoint: "http://localhost/api/notifications",
        apiToken: "token",
        timeoutMs: 2500,
        logger: mockLogger,
      });

      expect(mockedCreate).toHaveBeenCalledWith(
        expect.objectContaining({ timeout: 2500 }),
      );
    });

    it("should disable the request timeout when timeoutMs is 0", () => {
      new NotificationsClient({
        apiEndpoint: "http://localhost/api/notifications",
        apiToken: "token",
        timeoutMs: 0,
        logger: mockLogger,
      });

      expect(mockedCreate).toHaveBeenCalledWith(
        expect.objectContaining({ timeout: 0 }),
      );
    });

    it.each([Number.NaN, -1, Number.POSITIVE_INFINITY])(
      "should fall back to the default timeout for invalid value %s",
      (timeoutMs) => {
        new NotificationsClient({
          apiEndpoint: "http://localhost/api/notifications",
          apiToken: "token",
          timeoutMs,
          logger: mockLogger,
        });

        expect(mockedCreate).toHaveBeenCalledWith(
          expect.objectContaining({ timeout: 10000 }),
        );
      },
    );
  });

  describe("send", () => {
    it("should return null silently when disabled", async () => {
      const client = new NotificationsClient({
        apiEndpoint: "",
        apiToken: "",
        logger: mockLogger,
      });
      jest.clearAllMocks(); // drop the startup log

      const result = await client.send({ title: "Test" });

      expect(result).toBeNull();
      expect(mockPost).not.toHaveBeenCalled();
      expect(mockLogger.info).not.toHaveBeenCalled();
      expect(mockLogger.warn).not.toHaveBeenCalled();
      expect(mockLogger.error).not.toHaveBeenCalled();
    });

    it("should post with default values when payload fields are omitted", async () => {
      const client = new NotificationsClient({
        apiEndpoint: "http://localhost/api/notifications",
        apiToken: "token",
        logger: mockLogger,
      });
      const response = {
        id: "id-1",
        title: "Test",
        body: "",
        source: "api",
        severity: "info",
        data: "{}",
        createdAt: "2026-08-26T00:00:00.000Z",
      };
      mockPost.mockResolvedValue({ data: response });

      const result = await client.send({ title: "Test" });

      expect(mockPost).toHaveBeenCalledWith("/", {
        title: "Test",
        body: "",
        source: "api",
        severity: "info",
        data: "{}",
      });
      expect(result).toEqual(response);
    });

    it("should pass through explicit payload values", async () => {
      const client = new NotificationsClient({
        apiEndpoint: "http://localhost/api/notifications",
        apiToken: "token",
        logger: mockLogger,
      });
      mockPost.mockResolvedValue({ data: {} });

      await client.send({
        title: "Alert",
        body: "Something happened",
        source: "my-app",
        severity: "error",
        data: '{"key":"value"}',
      });

      expect(mockPost).toHaveBeenCalledWith("/", {
        title: "Alert",
        body: "Something happened",
        source: "my-app",
        severity: "error",
        data: '{"key":"value"}',
      });
    });

    it("should return null and log an error when the request fails", async () => {
      const client = new NotificationsClient({
        apiEndpoint: "http://localhost/api/notifications",
        apiToken: "token",
        logger: mockLogger,
      });
      const failure = new Error("network down");
      mockPost.mockRejectedValue(failure);

      const result = await client.send({ title: "Test" });

      expect(result).toBeNull();
      expect(mockLogger.error).toHaveBeenCalledWith(
        "NotificationsClient: failed to send notification",
        { name: "Error", message: "network down" },
      );
    });

    it("should never log the request config or Authorization header", async () => {
      const client = new NotificationsClient({
        apiEndpoint: "http://localhost/api/notifications",
        apiToken: "super-secret-token",
        logger: mockLogger,
      });
      const failure = Object.assign(new Error("Request failed 500"), {
        isAxiosError: true,
        code: "ERR_BAD_RESPONSE",
        config: { headers: { Authorization: "Bearer super-secret-token" } },
        response: { status: 500 },
      });
      mockPost.mockRejectedValue(failure);

      await client.send({ title: "Test" });

      const logged = mockLogger.error.mock.calls[0][1];
      expect(logged).toEqual({
        name: "Error",
        message: "Request failed 500",
        status: 500,
        code: "ERR_BAD_RESPONSE",
      });
      expect(JSON.stringify(logged)).not.toContain("super-secret-token");
      expect(JSON.stringify(logged)).not.toContain("Authorization");
      expect(JSON.stringify(logged)).not.toContain("config");
    });

    it("should not reject when the request fails", async () => {
      const client = new NotificationsClient({
        apiEndpoint: "http://localhost/api/notifications",
        apiToken: "token",
        logger: mockLogger,
      });
      mockPost.mockRejectedValue(new Error("network down"));

      await expect(client.send({ title: "Test" })).resolves.toBeNull();
    });

    describe("retry", () => {
      function createRetryingClient(): NotificationsClient {
        return new NotificationsClient({
          apiEndpoint: "http://localhost/api/notifications",
          apiToken: "super-secret-token",
          logger: mockLogger,
          retry: { maxAttempts: 3, baseDelayMs: 0 },
        });
      }

      const response = {
        id: "id-1",
        title: "Test",
        body: "",
        source: "api",
        severity: "info",
        data: "{}",
        createdAt: "2026-08-26T00:00:00.000Z",
      };

      function axiosError(status: number): Error {
        return Object.assign(new Error(`Request failed ${status}`), {
          isAxiosError: true,
          config: { headers: { Authorization: "Bearer super-secret-token" } },
          response: { status },
        });
      }

      it("should not retry by default", async () => {
        mockPost.mockRejectedValue(axiosError(503));
        const client = new NotificationsClient({
          apiEndpoint: "http://localhost/api/notifications",
          apiToken: "token",
          logger: mockLogger,
        });

        await expect(client.send({ title: "Test" })).resolves.toBeNull();
        expect(mockPost).toHaveBeenCalledTimes(1);
        expect(mockLogger.warn).not.toHaveBeenCalled();
      });

      it("should retry transient failures and succeed", async () => {
        mockPost
          .mockRejectedValueOnce(axiosError(503))
          .mockRejectedValueOnce(axiosError(429))
          .mockResolvedValueOnce({ data: response });
        const client = createRetryingClient();

        const result = await client.send({ title: "Test" });

        expect(result).toEqual(response);
        expect(mockPost).toHaveBeenCalledTimes(3);
        expect(mockLogger.warn).toHaveBeenCalledTimes(2);
        expect(mockLogger.warn.mock.calls[0][0]).toContain("HTTP 503");
        expect(mockLogger.warn.mock.calls[1][0]).toContain("HTTP 429");
        expect(mockLogger.error).not.toHaveBeenCalled();
      });

      it("should retry network errors without a response", async () => {
        mockPost
          .mockRejectedValueOnce(
            Object.assign(new Error("socket hang up"), {
              isAxiosError: true,
            }),
          )
          .mockResolvedValueOnce({ data: response });
        const client = createRetryingClient();

        await expect(client.send({ title: "Test" })).resolves.toEqual(
          response,
        );
        expect(mockPost).toHaveBeenCalledTimes(2);
      });

      it("should not retry non-retryable 4xx failures", async () => {
        mockPost.mockRejectedValue(axiosError(400));
        const client = createRetryingClient();

        await expect(client.send({ title: "Test" })).resolves.toBeNull();
        expect(mockPost).toHaveBeenCalledTimes(1);
        expect(mockLogger.warn).not.toHaveBeenCalled();
      });

      it("should give up after maxAttempts and return null", async () => {
        mockPost.mockRejectedValue(axiosError(500));
        const client = createRetryingClient();

        await expect(client.send({ title: "Test" })).resolves.toBeNull();
        expect(mockPost).toHaveBeenCalledTimes(3);
        expect(mockLogger.error).toHaveBeenCalledTimes(1);
      });

      it("should never log the API token in retry warnings", async () => {
        mockPost
          .mockRejectedValueOnce(axiosError(503))
          .mockResolvedValueOnce({ data: response });
        const client = createRetryingClient();

        await client.send({ title: "Test" });

        const warnings = JSON.stringify(mockLogger.warn.mock.calls);
        expect(warnings).not.toContain("super-secret-token");
        expect(warnings).not.toContain("Authorization");
      });
    });
  });

  describe("severity helpers", () => {
    it.each([
      ["info", "info"],
      ["success", "success"],
      ["warning", "warning"],
      ["error", "error"],
    ] as const)(
      "should send a %s notification",
      async (method, severity) => {
        const client = new NotificationsClient({
          apiEndpoint: "http://localhost/api/notifications",
          apiToken: "token",
          logger: mockLogger,
        });
        mockPost.mockResolvedValue({ data: {} });

        await client[method]("Title", "Body", "my-app");

        expect(mockPost).toHaveBeenCalledWith(
          "/",
          expect.objectContaining({
            title: "Title",
            body: "Body",
            source: "my-app",
            severity,
          }),
        );
      },
    );

    it("should return null silently from helpers when disabled", async () => {
      const client = new NotificationsClient({
        apiEndpoint: "",
        apiToken: "",
        logger: mockLogger,
      });
      jest.clearAllMocks(); // drop the startup log

      expect(await client.info("Title")).toBeNull();
      expect(await client.success("Title")).toBeNull();
      expect(await client.warning("Title")).toBeNull();
      expect(await client.error("Title")).toBeNull();
      expect(mockPost).not.toHaveBeenCalled();
      expect(mockLogger.info).not.toHaveBeenCalled();
      expect(mockLogger.error).not.toHaveBeenCalled();
    });
  });
});
