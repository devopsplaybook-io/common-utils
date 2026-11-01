import { UserRole, UserScope } from "./User";

export interface UserSession {
  isAuthenticated: boolean;
  userId?: string;
  userName?: string;
  role?: UserRole;
  scopes?: UserScope[];
  /** Credential that authenticated the request. */
  credentialType?: "jwt" | "api_token";
  /** JWT `iat` claim (seconds since the epoch). */
  issuedAt?: number;
  /** JWT `exp` claim (seconds since the epoch). */
  expiresAt?: number;
  /**
   * Start of the session (seconds since the epoch): the `sessionStartedAt`
   * claim, falling back to `issuedAt` for tokens issued before 2.6.0.
   */
  sessionStartedAt?: number;
}
