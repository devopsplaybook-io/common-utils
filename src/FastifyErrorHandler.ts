import { STATUS_CODES } from "http";
import { FastifyInstance, FastifyReply } from "fastify";

/** Response body produced by the shared Fastify error handler. */
export interface FastifyErrorHandlerBody {
  statusCode: number;
  error: string;
  message: string;
  code?: string;
}

const INTERNAL_SERVER_ERROR = "Internal Server Error";

/**
 * Resolve the response status the same way Fastify's default handler does:
 * a status already set on the reply wins, then the error status code, and
 * anything outside 400-599 falls back to 500.
 */
function resolveStatusCode(error: unknown, reply: FastifyReply): number {
  if (reply.statusCode >= 400 && reply.statusCode <= 599) {
    return reply.statusCode;
  }
  const record =
    typeof error === "object" && error !== null
      ? (error as { statusCode?: unknown; status?: unknown })
      : {};
  const errorStatus =
    typeof record.statusCode === "number"
      ? record.statusCode
      : typeof record.status === "number"
        ? record.status
        : 0;
  return errorStatus >= 400 && errorStatus <= 599 ? errorStatus : 500;
}

/** Read the message and code of a thrown value without assuming its type. */
function resolveErrorDetails(error: unknown): {
  message: string;
  code?: string;
} {
  const record =
    typeof error === "object" && error !== null
      ? (error as { message?: unknown; code?: unknown })
      : {};
  return {
    message: typeof record.message === "string" ? record.message : "",
    code:
      typeof record.code === "string" && record.code !== ""
        ? record.code
        : undefined,
  };
}

/**
 * Register a Fastify error handler that keeps server-side failure details
 * out of HTTP responses.
 *
 * Server errors (5xx) answer with the generic status label only: the thrown
 * message and its `code` (a database driver code such as `SQLITE_READONLY`,
 * for example) stay in the server logs and never reach the client. Client
 * errors (4xx) keep their message and code so validation and plugin errors
 * (rate limiting, payload limits, invalid bodies) remain actionable.
 *
 * The original error is logged at error level for 5xx responses; call it
 * right after creating the Fastify instance and before registering routes
 * so the handler is inherited by nested plugins.
 */
export function FastifyErrorHandlerRegister(fastify: FastifyInstance): void {
  fastify.setErrorHandler((error, request, reply) => {
    if (reply.sent) {
      return;
    }
    const statusCode = resolveStatusCode(error, reply);
    if (statusCode >= 500) {
      request.log.error({ err: error }, "Request failed");
      reply.status(statusCode).send({
        statusCode,
        error: STATUS_CODES[statusCode] ?? INTERNAL_SERVER_ERROR,
        message: STATUS_CODES[statusCode] ?? INTERNAL_SERVER_ERROR,
      });
      return;
    }
    const label = STATUS_CODES[statusCode] ?? "Error";
    const details = resolveErrorDetails(error);
    const body: FastifyErrorHandlerBody = {
      statusCode,
      error: label,
      message: details.message || label,
    };
    if (details.code) {
      body.code = details.code;
    }
    reply.status(statusCode).send(body);
  });
}
