import { v4 as uuidv4 } from "uuid";

/**
 * User-scoped API token.
 *
 * Only the SHA-256 hash of the token value is ever stored; the plaintext
 * value is generated at creation time and shown to the user exactly once.
 * A token grants the same permissions as the user it belongs to, resolved
 * live on each request (role/scope changes apply immediately).
 */
export class UserApiToken {
  //
  public static fromJson(json: any): UserApiToken | null {
    if (!json) {
      return null;
    }
    const apiToken = new UserApiToken();
    apiToken.id = json.id;
    apiToken.name = json.name;
    apiToken.userId = json.userId;
    apiToken.tokenHash = json.tokenHash;
    apiToken.dateCreated = json.dateCreated;
    apiToken.expiresAt = json.expiresAt ?? null;
    apiToken.lastUsedAt = json.lastUsedAt ?? null;
    return apiToken;
  }

  public id: string;
  public name!: string;
  public userId!: string;
  public tokenHash!: string;
  public dateCreated!: string;
  /** Optional ISO expiry (`null` = never expires). */
  public expiresAt: string | null = null;
  /** Last successful authentication with this token (best effort). */
  public lastUsedAt: string | null = null;

  constructor() {
    this.id = uuidv4();
  }

  public toJson(): any {
    return {
      id: this.id,
      name: this.name,
      userId: this.userId,
      tokenHash: this.tokenHash,
      dateCreated: this.dateCreated,
      expiresAt: this.expiresAt,
      lastUsedAt: this.lastUsedAt,
    };
  }

  // Transport representation: never exposes the token hash.
  public toTransportJson(): any {
    return {
      id: this.id,
      name: this.name,
      userId: this.userId,
      dateCreated: this.dateCreated,
      expiresAt: this.expiresAt,
      lastUsedAt: this.lastUsedAt,
    };
  }
}
