/**
 * Minimal, log-safe representation of an HTTP client error.
 * Request configuration, headers and response payloads are deliberately
 * excluded: an AxiosError carries `config.headers.Authorization` and must
 * never be logged as-is.
 */
export interface SanitizedHttpError {
  name: string;
  message: string;
  status?: number;
  code?: string;
}

/**
 * Reduce an unknown error to the fields safe to log.
 */
export function sanitizeHttpError(err: unknown): SanitizedHttpError {
  const error = (err ?? {}) as {
    name?: unknown;
    message?: unknown;
    code?: unknown;
    response?: { status?: unknown };
  };
  const sanitized: SanitizedHttpError = {
    name: typeof error.name === "string" ? error.name : "Error",
    message:
      typeof error.message === "string" ? error.message : String(err),
  };
  if (typeof error.response?.status === "number") {
    sanitized.status = error.response.status;
  }
  if (typeof error.code === "string") {
    sanitized.code = error.code;
  }
  return sanitized;
}
