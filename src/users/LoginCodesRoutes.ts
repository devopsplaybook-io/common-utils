import { OTelRequestSpan } from "@devopsplaybook.io/otel-utils-fastify";
import rateLimit, {
  FastifyRateLimitStoreCtor,
} from "@fastify/rate-limit";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Span } from "@opentelemetry/sdk-trace";
import { AuthAuditEmit } from "./AuthAudit";
import {
  LOGIN_CODE_CLEANUP_LIMIT,
  LOGIN_CODE_ERROR_ALREADY_USED,
  LOGIN_CODE_ERROR_FORBIDDEN,
  LOGIN_CODE_ERROR_INVALID_CODE,
  LOGIN_CODE_ERROR_PASSWORD_REQUIRED,
  LOGIN_CODE_ERROR_RATE_LIMITED,
  LOGIN_CODE_ERROR_UNAUTHENTICATED,
  LOGIN_CODE_ERROR_UNAVAILABLE,
  LOGIN_CODE_LENGTH,
  LOGIN_CODE_RETENTION_HOURS,
  LoginCodeDeviceLabel,
  LoginCodeGenerateCode,
  LoginCodeGenerateRequestToken,
  LoginCodeHashCode,
  LoginCodeHashRequestToken,
  LoginCodeIso,
  LoginCodeNewId,
  LoginCodeRecord,
  LoginCodeTruncateUserAgent,
  LoginCodesEvent,
  LoginCodesOptionsFromConfig,
  LoginCodesSettings,
  LoginCodesStore,
} from "./LoginCodes";
import {
  LoginCodeConsumeAttempt,
  LoginCodeIsExpiredAt,
  LoginCodeResolveByCode,
  LoginCodeRotateIfDue,
} from "./LoginCodesData";

/**
 * Fastify plugin exposing the cross-device "login with a code" protocol.
 *
 * Register it under a prefix (default `\/api\/users\/login-codes` when mounted
 * by `UsersRoutes`):
 * ```ts
 * fastify.register(LoginCodesRoutes, {
 *   prefix: "/api/users/login-codes",
 *   store: createLoginCodesStoreCommonUtils(),
 * });
 * ```
 *
 * The store, the user lookup, the session issuer, the password check, the
 * hashing key and the event sink are all injectable, so a fully custom auth
 * stack can use the module without the shared common-utils users modules.
 */

export interface LoginCodesUser {
  id: string;
  name: string;
  [key: string]: unknown;
}

export interface LoginCodesApprovingUser extends LoginCodesUser {
  /** Set by the default hook when the caller authenticated with an API token. */
  isApiToken?: boolean;
}

export interface LoginCodesSession {
  token: string;
  user: unknown;
}

/** Options accepted by {@link LoginCodesRoutes}. */
export interface LoginCodesRoutesOptions extends Partial<LoginCodesSettings> {
  /** Required: the atomic storage seam. */
  store: LoginCodesStore;
  /** Prefix used only by the `UsersRoutes` passthrough. */
  prefix?: string;
  /**
   * Resolve the approving device's user. Default: the live JWT user via
   * `AuthGetLiveUser`, with API tokens flagged (`isApiToken: true`) so they
   * are rejected. Return `null` when unauthenticated.
   */
  getApprovingUser?: (
    req: FastifyRequest,
  ) => Promise<LoginCodesApprovingUser | null>;
  /**
   * Re-read the approver live at redemption. Default: `UsersDataGet`. A user
   * that no longer exists fails the request closed.
   */
  getUserById?: (
    id: string,
  ) => Promise<LoginCodesApprovingUser | null>;
  /** Issue a fresh session for the redeemed user. Default: `AuthGenerateJWT`. */
  issueSession?: (
    user: LoginCodesApprovingUser,
    req: FastifyRequest,
  ) => Promise<LoginCodesSession>;
  /**
   * Verify the account password for approval step-up. Default:
   * `UserPasswordCheckPassword` against the resolved user's hash.
   */
  verifyPassword?: (
    user: LoginCodesApprovingUser,
    password: string,
  ) => Promise<boolean>;
  /**
   * HMAC key used to hash codes (and therefore never store them in plaintext).
   * Default: the deployment JWT key (`AuthGetJwtKey`). An empty key makes the
   * feature unavailable (`503`), never a boot crash.
   */
  hashKey?: string | (() => string | Promise<string>);
  /** Audit sink. Default: `AuthAuditEmit`. Never include secrets. */
  onEvent?: (event: LoginCodesEvent) => void;
  /** Shared `@fastify/rate-limit` store (multi-replica limits). */
  rateLimitStore?: FastifyRateLimitStoreCtor;
  /** Clock override for tests/determinism. */
  now?: () => number;
}

function resolveSettings(options: LoginCodesRoutesOptions): LoginCodesSettings {
  const defaults = LoginCodesOptionsFromConfig();
  return {
    enabled: options.enabled ?? defaults.enabled,
    ttlSeconds: options.ttlSeconds ?? defaults.ttlSeconds,
    rotationSeconds: options.rotationSeconds ?? defaults.rotationSeconds,
    graceSeconds: options.graceSeconds ?? defaults.graceSeconds,
    pollIntervalMs: options.pollIntervalMs ?? defaults.pollIntervalMs,
    maxAttempts: options.maxAttempts ?? defaults.maxAttempts,
    maxPending: options.maxPending ?? defaults.maxPending,
    rateLimitCreateMax:
      options.rateLimitCreateMax ?? defaults.rateLimitCreateMax,
    rateLimitPollMax: options.rateLimitPollMax ?? defaults.rateLimitPollMax,
    rateLimitApproveMax:
      options.rateLimitApproveMax ?? defaults.rateLimitApproveMax,
    rateLimitWindowSeconds:
      options.rateLimitWindowSeconds ?? defaults.rateLimitWindowSeconds,
    approveRequiresPassword:
      options.approveRequiresPassword ?? defaults.approveRequiresPassword,
  };
}

/** Credential-bearing responses must never be cached by browsers or proxies. */
function setNoStoreHeaders(res: any): void {
  res
    .header("cache-control", "no-store")
    .header("pragma", "no-cache")
    .header("vary", "Authorization");
}

/** Map a login-code event to a structured audit record (no secrets). */
function defaultOnEvent(event: LoginCodesEvent): void {
  AuthAuditEmit({
    action: event.type,
    outcome: event.type === "login_code_failed" ? "failure" : "success",
    reason: event.reason,
    actorId: event.userId,
    actorName: event.userName,
    requestId: event.requestId,
    deviceLabel: event.deviceLabel,
    ip: event.ip,
  });
}

/** Default approving-user resolution: live JWT user, API tokens rejected. */
async function defaultGetApprovingUser(
  req: FastifyRequest,
): Promise<LoginCodesApprovingUser | null> {
  const { AuthGetLiveUser, AuthGetUserSession } = await import("./Auth");
  const session = await AuthGetUserSession(req);
  if (!session.isAuthenticated) {
    return null;
  }
  if (session.credentialType === "api_token") {
    return {
      id: session.userId ?? "",
      name: session.userName ?? "",
      isApiToken: true,
    };
  }
  const user = await AuthGetLiveUser(req);
  if (!user) {
    return null;
  }
  return user as unknown as LoginCodesApprovingUser;
}

export async function LoginCodesRoutes(
  fastify: FastifyInstance,
  options: LoginCodesRoutesOptions,
): Promise<void> {
  if (!options || !options.store) {
    throw new Error("LoginCodesRoutes: a store is required");
  }
  const store = options.store;
  const settings = resolveSettings(options);
  const now = options.now ?? (() => Date.now());
  const onEvent = options.onEvent ?? defaultOnEvent;
  const windowMs = settings.rateLimitWindowSeconds * 1000;

  // ---- Rate limiting (same pattern as UsersRoutes) ----
  if (!fastify.hasDecorator("rateLimit")) {
    await fastify.register(rateLimit, {
      global: false,
      hook: "preHandler",
      store: options.rateLimitStore,
      errorResponseBuilder: (req: FastifyRequest, context: any) => ({
        statusCode: context.statusCode,
        error: "Too Many Requests",
        code: LOGIN_CODE_ERROR_RATE_LIMITED,
        message: `Rate limit exceeded, retry in ${context.after}`,
        serverTime: LoginCodeIso(now()),
      }),
    });
  } else if (options.rateLimitStore) {
    throw new Error(
      "LoginCodesRoutes: rateLimitStore cannot be set when @fastify/rate-limit is already registered; configure the store on the host registration instead",
    );
  }
  // Every response (including rate-limit rejections) carries the no-store
  // headers: the protocol hands out credentials.
  fastify.addHook("onSend", async (_req, res) => {
    setNoStoreHeaders(res);
  });

  // ---- Lazily resolved dependencies ----
  let hashKeyPromise: Promise<string> | undefined;
  async function resolveHashKey(): Promise<string> {
    if (!hashKeyPromise) {
      hashKeyPromise = (async () => {
        if (typeof options.hashKey === "string") {
          return options.hashKey;
        }
        if (typeof options.hashKey === "function") {
          return await options.hashKey();
        }
        const { AuthGetJwtKey } = await import("./Auth");
        return AuthGetJwtKey();
      })().catch(() => "");
    }
    return hashKeyPromise;
  }

  async function getApprovingUser(
    req: FastifyRequest,
  ): Promise<LoginCodesApprovingUser | null> {
    if (options.getApprovingUser) {
      return options.getApprovingUser(req);
    }
    return defaultGetApprovingUser(req);
  }

  async function getUserById(
    id: string,
  ): Promise<LoginCodesApprovingUser | null> {
    if (options.getUserById) {
      return options.getUserById(id);
    }
    const { UsersDataGet } = await import("./UsersData");
    return (await UsersDataGet(
      undefined,
      id,
    )) as unknown as LoginCodesApprovingUser | null;
  }

  async function issueSession(
    user: LoginCodesApprovingUser,
    req: FastifyRequest,
  ): Promise<LoginCodesSession> {
    if (options.issueSession) {
      return options.issueSession(user, req);
    }
    const { AuthGenerateJWT } = await import("./Auth");
    const { User } = await import("./User");
    const jwtUser =
      user instanceof User ? user : (User.fromJson(user) ?? (user as any));
    const token = await AuthGenerateJWT(jwtUser as any, {
      sessionStartedAt: Math.floor(now() / 1000),
    });
    const transport =
      jwtUser instanceof User ? jwtUser.toTransportJson() : jwtUser;
    return { token, user: transport };
  }

  async function verifyPassword(
    user: LoginCodesApprovingUser,
    password: string,
  ): Promise<boolean> {
    if (options.verifyPassword) {
      return options.verifyPassword(user, password);
    }
    const { UserPasswordCheckPassword } = await import("./UserPassword");
    return UserPasswordCheckPassword(undefined, user as any, password);
  }

  function emit(event: LoginCodesEvent): void {
    try {
      onEvent(event);
    } catch {
      // Auditing must never break the request path.
    }
  }

  function fail(
    res: any,
    status: number,
    code: string,
    message: string,
    nowMs: number,
  ): any {
    setNoStoreHeaders(res);
    return res
      .status(status)
      .send({ error: message, code, serverTime: LoginCodeIso(nowMs) });
  }

  /**
   * Gate the mutating endpoints on the feature being enabled, the HMAC key
   * being available and the table existing. Returns the key, or `null` after
   * sending the `503`.
   */
  async function requireAvailable(
    req: FastifyRequest,
    res: any,
    nowMs: number,
    context: Span | undefined,
  ): Promise<string | null> {
    if (!settings.enabled) {
      fail(
        res,
        503,
        LOGIN_CODE_ERROR_UNAVAILABLE,
        "Login Code Unavailable",
        nowMs,
      );
      return null;
    }
    const key = await resolveHashKey();
    if (key === "") {
      fail(
        res,
        503,
        LOGIN_CODE_ERROR_UNAVAILABLE,
        "Login Code Unavailable",
        nowMs,
      );
      return null;
    }
    let available = false;
    try {
      available = await store.available(context);
    } catch {
      available = false;
    }
    if (!available) {
      fail(
        res,
        503,
        LOGIN_CODE_ERROR_UNAVAILABLE,
        "Login Code Unavailable",
        nowMs,
      );
      return null;
    }
    return key;
  }

  /** Resolve the interactive approver; sends 401/403 and returns `null`. */
  async function requireApprover(
    req: FastifyRequest,
    res: any,
    nowMs: number,
  ): Promise<LoginCodesApprovingUser | null> {
    const approver = await getApprovingUser(req);
    if (!approver) {
      fail(
        res,
        401,
        LOGIN_CODE_ERROR_UNAUTHENTICATED,
        "Authentication Required",
        nowMs,
      );
      return null;
    }
    if (approver.isApiToken) {
      fail(
        res,
        403,
        LOGIN_CODE_ERROR_FORBIDDEN,
        "Session Token Required",
        nowMs,
      );
      return null;
    }
    return approver;
  }

  // ==================== CAPABILITIES ====================

  fastify.get("/capabilities", async (req, res) => {
    const nowMs = now();
    const context = OTelRequestSpan(req);
    let available = false;
    if (settings.enabled) {
      try {
        const key = await resolveHashKey();
        available = key !== "" && (await store.available(context));
      } catch {
        available = false;
      }
    }
    setNoStoreHeaders(res);
    return res.status(200).send({
      enabled: settings.enabled,
      available,
      codeLength: LOGIN_CODE_LENGTH,
      rotationSeconds: settings.rotationSeconds,
      graceSeconds: settings.graceSeconds,
      ttlSeconds: settings.ttlSeconds,
      pollIntervalMs: settings.pollIntervalMs,
      approveRequiresPassword: settings.approveRequiresPassword,
      serverTime: LoginCodeIso(nowMs),
    });
  });

  // ==================== CREATE ====================

  fastify.post(
    "/",
    settings.rateLimitCreateMax > 0
      ? {
          config: {
            rateLimit: {
              max: settings.rateLimitCreateMax,
              timeWindow: windowMs,
              keyGenerator: (req: FastifyRequest) => req.ip,
            },
          },
        }
      : {},
    async (req, res) => {
      const nowMs = now();
      const context = OTelRequestSpan(req);
      const key = await requireAvailable(req, res, nowMs, context);
      if (key === null) {
        return;
      }
      // Lazy, bounded cleanup: no scheduler, works with any replica count.
      try {
        await store.cleanup(
          {
            olderThan: LoginCodeIso(
              nowMs - LOGIN_CODE_RETENTION_HOURS * 3600 * 1000,
            ),
            limit: LOGIN_CODE_CLEANUP_LIMIT,
          },
          context,
        );
      } catch {
        // Best effort.
      }
      const userAgent = LoginCodeTruncateUserAgent(
        req.headers["user-agent"],
      );
      const expiresAt = LoginCodeIso(nowMs + settings.ttlSeconds * 1000);
      const codeExpiresAt = LoginCodeIso(
        nowMs + settings.rotationSeconds * 1000,
      );
      const createdAt = LoginCodeIso(nowMs);

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const requestToken = LoginCodeGenerateRequestToken();
        const code = LoginCodeGenerateCode();
        const created = await store.create(
          {
            id: LoginCodeNewId(),
            requestTokenHash: LoginCodeHashRequestToken(requestToken),
            codeHash: LoginCodeHashCode(code, key),
            codeExpiresAt,
            createdAt,
            updatedAt: createdAt,
            expiresAt,
            requestUserAgent: userAgent,
            maxPending: settings.maxPending,
          },
          context,
        );
        if (created.ok) {
          setNoStoreHeaders(res);
          return res.status(201).send({
            requestToken,
            code,
            codeExpiresAt,
            expiresAt,
            serverTime: LoginCodeIso(nowMs),
          });
        }
        if (created.reason === "pending_cap") {
          return fail(
            res,
            429,
            LOGIN_CODE_ERROR_RATE_LIMITED,
            "Too Many Requests",
            nowMs,
          );
        }
      }
      return fail(
        res,
        503,
        LOGIN_CODE_ERROR_UNAVAILABLE,
        "Login Code Unavailable",
        nowMs,
      );
    },
  );

  // ==================== POLL ====================

  fastify.post(
    "/poll",
    settings.rateLimitPollMax > 0
      ? {
          preHandler: fastify.rateLimit({
            max: settings.rateLimitPollMax,
            timeWindow: windowMs,
            keyGenerator: (req: FastifyRequest) => {
              const body = (req.body ?? {}) as { requestToken?: unknown };
              return typeof body.requestToken === "string" &&
                body.requestToken !== ""
                ? LoginCodeHashRequestToken(body.requestToken)
                : req.ip;
            },
            errorResponseBuilder: (req: FastifyRequest, context: any) => ({
              statusCode: context.statusCode,
              error: "Too Many Requests",
              code: LOGIN_CODE_ERROR_RATE_LIMITED,
              message: `Rate limit exceeded, retry in ${context.after}`,
              serverTime: LoginCodeIso(now()),
            }),
          }),
        }
      : {},
    async (req, res) => {
      const nowMs = now();
      const context = OTelRequestSpan(req);
      const key = await requireAvailable(req, res, nowMs, context);
      if (key === null) {
        return;
      }
      const body = (req.body ?? {}) as {
        requestToken?: unknown;
        refreshCode?: unknown;
      };
      if (
        typeof body.requestToken !== "string" ||
        body.requestToken === ""
      ) {
        return fail(
          res,
          400,
          LOGIN_CODE_ERROR_INVALID_CODE,
          "Invalid Code",
          nowMs,
        );
      }
      const requestTokenHash = LoginCodeHashRequestToken(body.requestToken);
      let record = await store.getByRequestTokenHash(
        requestTokenHash,
        context,
      );
      if (!record) {
        return fail(
          res,
          400,
          LOGIN_CODE_ERROR_INVALID_CODE,
          "Invalid Code",
          nowMs,
        );
      }
      setNoStoreHeaders(res);

      if (record.status === "consumed") {
        return fail(
          res,
          409,
          LOGIN_CODE_ERROR_ALREADY_USED,
          "Already Used",
          nowMs,
        );
      }

      if (LoginCodeIsExpiredAt(record, nowMs)) {
        if (record.status === "pending" || record.status === "approved") {
          await store
            .markExpired({ id: record.id, updatedAt: LoginCodeIso(nowMs) }, context)
            .catch(() => false);
          emit({
            type: "login_code_failed",
            requestId: record.id,
            deviceLabel: LoginCodeDeviceLabel(record.requestUserAgent),
            reason: "expired",
            ip: req.ip,
          });
        }
        return res.status(200).send({
          status: "expired",
          expiresAt: record.expiresAt,
          serverTime: LoginCodeIso(nowMs),
        });
      }

      if (record.status === "approved") {
        const approver = record.approvedByUserId
          ? await getUserById(record.approvedByUserId)
          : null;
        if (!approver) {
          await store
            .markFailed({ id: record.id, updatedAt: LoginCodeIso(nowMs) }, context)
            .catch(() => false);
          emit({
            type: "login_code_failed",
            requestId: record.id,
            userId: record.approvedByUserId ?? undefined,
            deviceLabel: LoginCodeDeviceLabel(record.requestUserAgent),
            reason: "approver_missing",
            ip: req.ip,
          });
          return res.status(200).send({
            status: "failed",
            expiresAt: record.expiresAt,
            serverTime: LoginCodeIso(nowMs),
          });
        }
        const consumed = await store.consume(
          {
            requestTokenHash,
            consumedAt: LoginCodeIso(nowMs),
            updatedAt: LoginCodeIso(nowMs),
          },
          context,
        );
        if (!consumed) {
          return fail(
            res,
            409,
            LOGIN_CODE_ERROR_ALREADY_USED,
            "Already Used",
            nowMs,
          );
        }
        const session = await issueSession(approver, req);
        emit({
          type: "login_code_consumed",
          requestId: consumed.id,
          userId: approver.id,
          userName: approver.name,
          deviceLabel: LoginCodeDeviceLabel(consumed.requestUserAgent),
          ip: req.ip,
        });
        return res.status(200).send({
          status: "approved",
          token: session.token,
          user: session.user,
          expiresAt: consumed.expiresAt,
          serverTime: LoginCodeIso(nowMs),
        });
      }

      if (record.status === "pending") {
        const rotation = await LoginCodeRotateIfDue(store, {
          record,
          hashKey: key,
          rotationSeconds: settings.rotationSeconds,
          graceSeconds: settings.graceSeconds,
          refreshCode: body.refreshCode === true,
          nowMs,
          context,
        });
        record = rotation.record;
        if (rotation.rotated) {
          return res.status(200).send({
            status: "pending",
            code: rotation.code,
            codeExpiresAt: record.codeExpiresAt,
            expiresAt: record.expiresAt,
            serverTime: LoginCodeIso(nowMs),
          });
        }
        return res.status(200).send({
          status: "pending",
          codeExpiresAt: record.codeExpiresAt,
          expiresAt: record.expiresAt,
          serverTime: LoginCodeIso(nowMs),
        });
      }

      // cancelled / failed
      return res.status(200).send({
        status: record.status,
        expiresAt: record.expiresAt,
        serverTime: LoginCodeIso(nowMs),
      });
    },
  );

  // ==================== SHARED PREVIEW/APPROVE LOOKUP ====================

  /**
   * Resolve a submitted code, enforce TTL/status, consume one attempt and
   * return the record plus the hash that matched. Sends the error response and
   * returns `null` on failure.
   */
  async function resolveForApproval(
    req: FastifyRequest,
    res: any,
    code: unknown,
    key: string,
    nowMs: number,
    context: Span | undefined,
  ): Promise<{ record: LoginCodeRecord; matchedCodeHash: string } | null> {
    const resolved = await LoginCodeResolveByCode(store, {
      code,
      hashKey: key,
      nowMs,
      context,
    });
    if (!resolved) {
      fail(
        res,
        400,
        LOGIN_CODE_ERROR_INVALID_CODE,
        "Invalid Code",
        nowMs,
      );
      return null;
    }
    const record = resolved.record;
    if (LoginCodeIsExpiredAt(record, nowMs)) {
      await store
        .markExpired({ id: record.id, updatedAt: LoginCodeIso(nowMs) }, context)
        .catch(() => false);
      fail(
        res,
        400,
        LOGIN_CODE_ERROR_INVALID_CODE,
        "Invalid Code",
        nowMs,
      );
      return null;
    }
    if (record.status !== "pending") {
      fail(
        res,
        400,
        LOGIN_CODE_ERROR_INVALID_CODE,
        "Invalid Code",
        nowMs,
      );
      return null;
    }
    const attempt = await LoginCodeConsumeAttempt(store, {
      record,
      maxAttempts: settings.maxAttempts,
      nowMs,
      context,
    });
    if (!attempt.allowed) {
      if (attempt.record?.status === "pending") {
        await store
          .markFailed(
            { id: record.id, updatedAt: LoginCodeIso(nowMs) },
            context,
          )
          .catch(() => false);
        emit({
          type: "login_code_failed",
          requestId: record.id,
          deviceLabel: LoginCodeDeviceLabel(record.requestUserAgent),
          reason: "attempts_exceeded",
          ip: req.ip,
        });
      }
      fail(
        res,
        400,
        LOGIN_CODE_ERROR_INVALID_CODE,
        "Invalid Code",
        nowMs,
      );
      return null;
    }
    return {
      record: {
        ...record,
        attempts: record.attempts + 1,
      },
      matchedCodeHash: resolved.matchedCodeHash,
    };
  }

  // ==================== PREVIEW ====================

  fastify.post(
    "/preview",
    settings.rateLimitApproveMax > 0
      ? {
          config: {
            rateLimit: {
              max: settings.rateLimitApproveMax,
              timeWindow: windowMs,
              keyGenerator: (req: FastifyRequest) => req.ip,
            },
          },
        }
      : {},
    async (req, res) => {
      const nowMs = now();
      const context = OTelRequestSpan(req);
      const key = await requireAvailable(req, res, nowMs, context);
      if (key === null) {
        return;
      }
      const approver = await requireApprover(req, res, nowMs);
      if (!approver) {
        return;
      }
      const body = (req.body ?? {}) as { code?: unknown };
      const resolved = await resolveForApproval(
        req,
        res,
        body.code,
        key,
        nowMs,
        context,
      );
      if (!resolved) {
        return;
      }
      const record = resolved.record;
      setNoStoreHeaders(res);
      return res.status(200).send({
        deviceLabel: LoginCodeDeviceLabel(record.requestUserAgent),
        userAgent: record.requestUserAgent,
        createdAt: record.createdAt,
        expiresAt: record.expiresAt,
        userName: approver.name,
        serverTime: LoginCodeIso(nowMs),
      });
    },
  );

  // ==================== APPROVE ====================

  fastify.post(
    "/approve",
    settings.rateLimitApproveMax > 0
      ? {
          config: {
            rateLimit: {
              max: settings.rateLimitApproveMax,
              timeWindow: windowMs,
              keyGenerator: (req: FastifyRequest) => req.ip,
            },
          },
        }
      : {},
    async (req, res) => {
      const nowMs = now();
      const context = OTelRequestSpan(req);
      const key = await requireAvailable(req, res, nowMs, context);
      if (key === null) {
        return;
      }
      const approver = await requireApprover(req, res, nowMs);
      if (!approver) {
        return;
      }
      const body = (req.body ?? {}) as {
        code?: unknown;
        password?: unknown;
      };
      if (
        settings.approveRequiresPassword &&
        (typeof body.password !== "string" || body.password === "")
      ) {
        return fail(
          res,
          400,
          LOGIN_CODE_ERROR_PASSWORD_REQUIRED,
          "Password Required",
          nowMs,
        );
      }
      const record = await resolveForApproval(
        req,
        res,
        body.code,
        key,
        nowMs,
        context,
      );
      if (!record) {
        return;
      }
      if (settings.approveRequiresPassword) {
        const passwordOk = await verifyPassword(
          approver,
          body.password as string,
        );
        if (!passwordOk) {
          return fail(
            res,
            400,
            LOGIN_CODE_ERROR_INVALID_CODE,
            "Invalid Code",
            nowMs,
          );
        }
      }
      const approved = await store.approve(
        {
          id: record.record.id,
          submittedCodeHash: record.matchedCodeHash,
          now: LoginCodeIso(nowMs),
          approvedByUserId: approver.id,
          approvedAt: LoginCodeIso(nowMs),
        },
        context,
      );
      if (!approved) {
        return fail(
          res,
          400,
          LOGIN_CODE_ERROR_INVALID_CODE,
          "Invalid Code",
          nowMs,
        );
      }
      emit({
        type: "login_code_approved",
        requestId: record.record.id,
        userId: approver.id,
        userName: approver.name,
        deviceLabel: LoginCodeDeviceLabel(record.record.requestUserAgent),
        ip: req.ip,
      });
      setNoStoreHeaders(res);
      return res.status(200).send({
        approved: true,
        expiresAt: record.record.expiresAt,
        serverTime: LoginCodeIso(nowMs),
      });
    },
  );

  // ==================== CANCEL ====================

  fastify.post(
    "/cancel",
    settings.rateLimitApproveMax > 0
      ? {
          config: {
            rateLimit: {
              max: settings.rateLimitApproveMax,
              timeWindow: windowMs,
              keyGenerator: (req: FastifyRequest) => req.ip,
            },
          },
        }
      : {},
    async (req, res) => {
      const nowMs = now();
      const context = OTelRequestSpan(req);
      const unusedKey = await requireAvailable(req, res, nowMs, context);
      if (unusedKey === null) {
        return;
      }
      const body = (req.body ?? {}) as { requestToken?: unknown };
      if (
        typeof body.requestToken !== "string" ||
        body.requestToken === ""
      ) {
        return fail(
          res,
          400,
          LOGIN_CODE_ERROR_INVALID_CODE,
          "Invalid Code",
          nowMs,
        );
      }
      const requestTokenHash = LoginCodeHashRequestToken(body.requestToken);
      const record = await store.getByRequestTokenHash(
        requestTokenHash,
        context,
      );
      if (!record) {
        return fail(
          res,
          400,
          LOGIN_CODE_ERROR_INVALID_CODE,
          "Invalid Code",
          nowMs,
        );
      }
      if (record.status === "cancelled") {
        setNoStoreHeaders(res);
        return res.status(200).send({
          status: "cancelled",
          serverTime: LoginCodeIso(nowMs),
        });
      }
      if (record.status === "approved" || record.status === "consumed") {
        return fail(
          res,
          409,
          LOGIN_CODE_ERROR_ALREADY_USED,
          "Already Used",
          nowMs,
        );
      }
      if (record.status !== "pending") {
        return fail(
          res,
          400,
          LOGIN_CODE_ERROR_INVALID_CODE,
          "Invalid Code",
          nowMs,
        );
      }
      const cancelled = await store.cancel(
        { requestTokenHash, updatedAt: LoginCodeIso(nowMs) },
        context,
      );
      if (!cancelled) {
        const refreshed = await store.getByRequestTokenHash(
          requestTokenHash,
          context,
        );
        if (refreshed?.status === "cancelled") {
          setNoStoreHeaders(res);
          return res.status(200).send({
            status: "cancelled",
            serverTime: LoginCodeIso(nowMs),
          });
        }
        if (
          refreshed?.status === "approved" ||
          refreshed?.status === "consumed"
        ) {
          return fail(
            res,
            409,
            LOGIN_CODE_ERROR_ALREADY_USED,
            "Already Used",
            nowMs,
          );
        }
        return fail(
          res,
          400,
          LOGIN_CODE_ERROR_INVALID_CODE,
          "Invalid Code",
          nowMs,
        );
      }
      emit({
        type: "login_code_cancelled",
        requestId: record.id,
        deviceLabel: LoginCodeDeviceLabel(record.requestUserAgent),
        ip: req.ip,
      });
      setNoStoreHeaders(res);
      return res.status(200).send({
        status: "cancelled",
        serverTime: LoginCodeIso(nowMs),
      });
    },
  );
}
