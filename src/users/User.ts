import { v4 as uuidv4 } from "uuid";

/**
 * User role. `admin` bypasses scope checks; `user` is restricted
 * to its granted scopes.
 */
export type UserRole = "admin" | "user";

/**
 * Scope identifier restricting what a non-admin user can access.
 * Each application defines its own scope set (e.g. `"traces"`, `"metrics"`)
 * and registers it through `AuthInit`.
 */
export type UserScope = string;

export class User {
  //
  public static DEFAULT_SCOPES: UserScope[] = [];
  /** Full scope set of the host application, registered via `AuthInit`. */
  public static ALL_SCOPES: UserScope[] = [];

  /**
   * Coerce a stored scope value to an array: JSON string and array columns
   * are both accepted, anything else falls back to the default scopes.
   */
  public static normalizeScopes(value: unknown): UserScope[] {
    if (Array.isArray(value)) {
      return [...value] as UserScope[];
    }
    if (typeof value === "string") {
      try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed)) {
          return parsed as UserScope[];
        }
      } catch {
        // fall through to the default scopes
      }
    }
    return [...User.DEFAULT_SCOPES];
  }

  public static fromJson(json: any): User | null {
    if (!json) {
      return null;
    }
    const user = new User();
    if (json.id) {
      user.id = json.id;
    }
    user.name = json.name;
    user.passwordEncrypted = json.passwordEncrypted;
    user.role = json.role || "user";
    user.tokenVersion = Number(json.tokenVersion ?? 0) || 0;
    if (json.scopes) {
      user.scopes = User.normalizeScopes(json.scopes);
    }
    return user;
  }

  public id: string;
  public name!: string;
  public passwordEncrypted!: string;
  public role: UserRole = "user";
  public scopes: UserScope[] = [...User.DEFAULT_SCOPES];
  /**
   * Incremented on password/role/scope changes when JWT revocation is
   * enabled; JWTs carry the value they were issued with.
   */
  public tokenVersion = 0;

  constructor() {
    this.id = uuidv4();
  }

  public toJson(): any {
    return {
      id: this.id,
      name: this.name,
      passwordEncrypted: this.passwordEncrypted,
      role: this.role,
      scopes: this.scopes,
      tokenVersion: this.tokenVersion,
    };
  }

  public toTransportJson(): any {
    return {
      id: this.id,
      name: this.name,
      role: this.role,
      scopes: this.scopes,
    };
  }
}
