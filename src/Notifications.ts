import axios, { AxiosInstance } from "axios";

/**
 * Severity levels for notifications.
 */
export type NotificationSeverity = "info" | "warning" | "error" | "success";

/**
 * Minimal logger interface expected by the notifications client.
 * Matches the subset of the OTel logger used by devopsplaybook.io projects.
 */
export interface NotificationsLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, err?: unknown): void;
}

/**
 * Configuration for {@link NotificationsClient}.
 */
export interface NotificationsConfig {
  /** API endpoint URL (e.g., "https://notifications.example.com/api/notifications") */
  apiEndpoint: string;
  /** API token used for Bearer authentication */
  apiToken: string;
  /** Optional logger; falls back to console when omitted */
  logger?: NotificationsLogger;
}

/**
 * Payload for creating a notification.
 */
export interface NotificationPayload {
  /** Notification title */
  title: string;
  /** Notification body/content */
  body?: string;
  /** Source identifier (defaults to "api") */
  source?: string;
  /** Severity level (defaults to "info") */
  severity?: NotificationSeverity;
  /** Additional data as a JSON string */
  data?: string;
}

/**
 * Response from the notifications API.
 */
export interface NotificationResponse {
  id: string;
  title: string;
  body: string;
  source: string;
  severity: string;
  data: string;
  createdAt: string;
}

/** Console fallback used when no logger is injected. */
const consoleLogger: NotificationsLogger = {
  info: (message: string) => console.log(message),
  warn: (message: string) => console.warn(message),
  error: (message: string, err?: unknown) => console.error(message, err),
};

/**
 * Client for sending notifications to the central notifications service.
 *
 * The client is fail-safe by design:
 *
 * - It is disabled (and never throws) when `apiEndpoint` or `apiToken` is
 *   missing, so a partially configured parent application still starts.
 * - The integration status is logged exactly once, at construction time.
 * - Follow-up `send` calls on a disabled client are silent and resolve to
 *   `null`.
 * - Sending errors are logged and resolve to `null` instead of rejecting.
 *
 * @example
 * ```ts
 * const client = new NotificationsClient({
 *   apiEndpoint: config.NOTIFICATIONS_API,
 *   apiToken: config.NOTIFICATIONS_TOKEN,
 *   logger: OTelLogger().createModuleLogger("notifications"),
 * });
 *
 * await client.send({
 *   title: "Deployment finished",
 *   body: "Version 1.2.3 deployed to production",
 *   source: "my-app",
 *   severity: "success",
 * });
 * ```
 */
export class NotificationsClient {
  private client: AxiosInstance | null = null;
  private readonly enabled: boolean;
  private readonly logger: NotificationsLogger;

  constructor(config: NotificationsConfig) {
    this.enabled = !!(config.apiEndpoint && config.apiToken);
    this.logger = config.logger || consoleLogger;

    if (this.enabled) {
      this.client = axios.create({
        baseURL: config.apiEndpoint,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiToken}`,
        },
        timeout: 10000,
      });
      this.logger.info("Notifications integration enabled");
    } else {
      this.logger.info(
        "Notifications integration disabled (apiEndpoint or apiToken not set)",
      );
    }
  }

  /**
   * Check whether the client is properly configured.
   */
  public isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Send a notification.
   *
   * @param payload  The notification payload.
   * @returns The created notification, or `null` when disabled or on failure.
   */
  public async send(
    payload: NotificationPayload,
  ): Promise<NotificationResponse | null> {
    if (!this.enabled || !this.client) {
      return null;
    }

    try {
      const response = await this.client.post<NotificationResponse>("/", {
        title: payload.title,
        body: payload.body || "",
        source: payload.source || "api",
        severity: payload.severity || "info",
        data: payload.data || "{}",
      });
      return response.data;
    } catch (err) {
      this.logger.error(
        "NotificationsClient: failed to send notification",
        err,
      );
      return null;
    }
  }

  /**
   * Send an info notification.
   */
  public async info(
    title: string,
    body?: string,
    source?: string,
  ): Promise<NotificationResponse | null> {
    return this.send({ title, body, source, severity: "info" });
  }

  /**
   * Send a success notification.
   */
  public async success(
    title: string,
    body?: string,
    source?: string,
  ): Promise<NotificationResponse | null> {
    return this.send({ title, body, source, severity: "success" });
  }

  /**
   * Send a warning notification.
   */
  public async warning(
    title: string,
    body?: string,
    source?: string,
  ): Promise<NotificationResponse | null> {
    return this.send({ title, body, source, severity: "warning" });
  }

  /**
   * Send an error notification.
   */
  public async error(
    title: string,
    body?: string,
    source?: string,
  ): Promise<NotificationResponse | null> {
    return this.send({ title, body, source, severity: "error" });
  }
}
