jest.mock("axios", () => ({
  create: jest.fn(),
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
        failure,
      );
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
