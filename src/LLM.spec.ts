jest.mock("axios", () => ({
  create: jest.fn(),
  isAxiosError: (err: unknown) =>
    typeof err === "object" &&
    err !== null &&
    (err as { isAxiosError?: boolean }).isAxiosError === true,
}));

import axios from "axios";
import { LLMClient, LLMLogger } from "./LLM";

const mockedCreate = axios.create as jest.MockedFunction<typeof axios.create>;

/** Logger double that records every call. */
function createMockLogger(): LLMLogger & {
  info: jest.Mock;
  error: jest.Mock;
} {
  return {
    info: jest.fn(),
    error: jest.fn(),
  };
}

describe("LLMClient", () => {
  let mockPost: jest.Mock;
  let mockLogger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPost = jest.fn();
    mockedCreate.mockReturnValue({ post: mockPost } as never);
    mockLogger = createMockLogger();
  });

  function createEnabledClient(): LLMClient {
    return new LLMClient({
      apiKey: "key",
      apiUrl: "https://api.example.com/chat/completions",
      model: "test-model",
      logger: mockLogger,
    });
  }

  describe("constructor", () => {
    it("should be enabled when apiKey, apiUrl and model are set", () => {
      const client = createEnabledClient();

      expect(client.isEnabled()).toBe(true);
      expect(mockedCreate).toHaveBeenCalledTimes(1);
    });

    it("should create the HTTP client with auth header and timeout", () => {
      new LLMClient({
        apiKey: "key",
        apiUrl: "https://api.example.com/chat/completions",
        model: "test-model",
        timeoutMs: 42000,
        logger: mockLogger,
      });

      expect(mockedCreate).toHaveBeenCalledWith({
        baseURL: "https://api.example.com/chat/completions",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer key",
        },
        timeout: 42000,
      });
    });

    it("should default the timeout to 120000 ms", () => {
      createEnabledClient();

      expect(mockedCreate).toHaveBeenCalledWith(
        expect.objectContaining({ timeout: 120000 }),
      );
    });

    it.each([
      ["apiKey", { apiKey: "" }],
      ["apiUrl", { apiUrl: "" }],
      ["model", { model: "" }],
    ])("should be disabled when %s is empty", (_name, override) => {
      const client = new LLMClient({
        apiKey: "key",
        apiUrl: "https://api.example.com/chat/completions",
        model: "test-model",
        logger: mockLogger,
        ...override,
      });

      expect(client.isEnabled()).toBe(false);
      expect(mockedCreate).not.toHaveBeenCalled();
    });

    it("should log the integration status exactly once at construction", () => {
      createEnabledClient();

      expect(mockLogger.info).toHaveBeenCalledTimes(1);
      expect(mockLogger.info).toHaveBeenCalledWith(
        "LLM integration enabled (model: test-model)",
      );
    });

    it("should log the disabled status when misconfigured", () => {
      new LLMClient({
        apiKey: "",
        apiUrl: "",
        model: "",
        logger: mockLogger,
      });

      expect(mockLogger.info).toHaveBeenCalledWith(
        "LLM integration disabled (apiKey, apiUrl or model not set)",
      );
    });
  });

  describe("request", () => {
    it("should throw when the client is disabled", async () => {
      const client = new LLMClient({
        apiKey: "",
        apiUrl: "",
        model: "",
        logger: mockLogger,
      });

      await expect(
        client.request([{ role: "user", content: "hello" }]),
      ).rejects.toThrow("LLM integration disabled");
      expect(mockPost).not.toHaveBeenCalled();
    });

    it("should send model and messages without response_format by default", async () => {
      mockPost.mockResolvedValue({
        data: {
          choices: [{ message: { content: "hi there" } }],
          usage: { total_tokens: 12 },
        },
      });
      const client = createEnabledClient();

      const response = await client.request([
        { role: "system", content: "be brief" },
        { role: "user", content: "hello" },
      ]);

      expect(mockPost).toHaveBeenCalledWith("", {
        model: "test-model",
        messages: [
          { role: "system", content: "be brief" },
          { role: "user", content: "hello" },
        ],
        stream: false,
      });
      expect(response).toEqual({ content: "hi there", totalTokens: 12 });
    });

    it("should add response_format json_object in jsonMode", async () => {
      mockPost.mockResolvedValue({
        data: {
          choices: [{ message: { content: "{}" } }],
          usage: { total_tokens: 1 },
        },
      });
      const client = createEnabledClient();

      await client.request([{ role: "user", content: "hello" }], {
        jsonMode: true,
      });

      expect(mockPost).toHaveBeenCalledWith(
        "",
        expect.objectContaining({
          response_format: { type: "json_object" },
        }),
      );
    });

    it("should override the model per request", async () => {
      mockPost.mockResolvedValue({
        data: {
          choices: [{ message: { content: "ok" } }],
          usage: { total_tokens: 1 },
        },
      });
      const client = createEnabledClient();

      await client.request([{ role: "user", content: "hello" }], {
        model: "other-model",
      });

      expect(mockPost).toHaveBeenCalledWith(
        "",
        expect.objectContaining({ model: "other-model" }),
      );
    });

    it("should override the timeout per request", async () => {
      mockPost.mockResolvedValue({
        data: {
          choices: [{ message: { content: "ok" } }],
          usage: { total_tokens: 1 },
        },
      });
      const client = createEnabledClient();

      await client.request([{ role: "user", content: "hello" }], {
        timeoutMs: 600000,
      });

      expect(mockPost).toHaveBeenCalledWith(
        "",
        expect.anything(),
        expect.objectContaining({ timeout: 600000 }),
      );
    });

    it("should disable the timeout when timeoutMs is 0", async () => {
      mockPost.mockResolvedValue({
        data: {
          choices: [{ message: { content: "ok" } }],
          usage: { total_tokens: 1 },
        },
      });
      const client = createEnabledClient();

      await client.request([{ role: "user", content: "hello" }], {
        timeoutMs: 0,
      });

      expect(mockPost).toHaveBeenCalledWith(
        "",
        expect.anything(),
        expect.objectContaining({ timeout: 0 }),
      );
    });

    it("should not pass a request config when no timeout override is given", async () => {
      mockPost.mockResolvedValue({
        data: {
          choices: [{ message: { content: "ok" } }],
          usage: { total_tokens: 1 },
        },
      });
      const client = createEnabledClient();

      await client.request([{ role: "user", content: "hello" }]);

      expect(mockPost).toHaveBeenCalledTimes(1);
      expect(mockPost.mock.calls[0]).toHaveLength(2);
    });

    it("should default totalTokens to 0 and content to empty string", async () => {
      mockPost.mockResolvedValue({
        data: { choices: [{ message: { content: null } }] },
      });
      const client = createEnabledClient();

      const response = await client.request([
        { role: "user", content: "hello" },
      ]);

      expect(response).toEqual({ content: "", totalTokens: 0 });
    });

    it("should throw when the response has no choices", async () => {
      mockPost.mockResolvedValue({ data: {} });
      const client = createEnabledClient();

      await expect(
        client.request([{ role: "user", content: "hello" }]),
      ).rejects.toThrow("LLM response has no choices");
    });

    it("should surface the provider error message", async () => {
      const axiosError = Object.assign(new Error("Request failed 401"), {
        isAxiosError: true,
        response: { data: { error: { message: "Invalid API key" } } },
      });
      mockPost.mockRejectedValue(axiosError);
      const client = createEnabledClient();

      await expect(
        client.request([{ role: "user", content: "hello" }]),
      ).rejects.toThrow("Invalid API key");
      expect(mockLogger.error).toHaveBeenCalledWith(
        "LLMClient: request failed (Invalid API key)",
        axiosError,
      );
    });

    it("should keep the original message for non-provider errors", async () => {
      mockPost.mockRejectedValue(new Error("Network down"));
      const client = createEnabledClient();

      await expect(
        client.request([{ role: "user", content: "hello" }]),
      ).rejects.toThrow("Network down");
    });
  });
});
