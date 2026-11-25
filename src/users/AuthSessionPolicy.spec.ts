import * as fs from "fs";
import * as path from "path";
import {
  AUTH_SESSION_POLICY_APPS,
  AUTH_SESSION_STANDARD,
  AuthSessionPolicyAssert,
  AuthSessionPolicyCheck,
  AuthSessionPolicyLog,
} from "./AuthSessionPolicy";

const STANDARD = {
  JWT_VALIDITY_DURATION: AUTH_SESSION_STANDARD.validitySeconds,
  JWT_SESSION_MAX_DURATION: AUTH_SESSION_STANDARD.maxDurationSeconds,
};

describe("AuthSessionPolicyCheck", () => {
  it("accepts the standard rule for an app that follows it", () => {
    const result = AuthSessionPolicyCheck(STANDARD, { app: "notifications" });

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.slidingRenewal).toBe(true);
    expect(result.validitySeconds).toBe(2592000);
    expect(result.maxDurationSeconds).toBe(7776000);
  });

  it("rejects an unreasonably short validity", () => {
    const result = AuthSessionPolicyCheck(
      { ...STANDARD, JWT_VALIDITY_DURATION: 60 },
      { app: "notifications" },
    );

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/below the 3600s minimum/);
  });

  it("allows a documented short validity when the app is an exception", () => {
    const result = AuthSessionPolicyCheck(
      { JWT_VALIDITY_DURATION: 900, JWT_SESSION_MAX_DURATION: 7776000 },
      { app: "studyguide" },
    );

    expect(result.ok).toBe(true);
  });

  it("allows a short validity when allowShortValidity is passed explicitly", () => {
    const result = AuthSessionPolicyCheck(
      { JWT_VALIDITY_DURATION: 900, JWT_SESSION_MAX_DURATION: 900 },
      { allowShortValidity: true },
    );

    expect(result.ok).toBe(true);
  });

  it("rejects a cap smaller than the validity when sliding renewal is expected", () => {
    const result = AuthSessionPolicyCheck(
      { JWT_VALIDITY_DURATION: 2592000, JWT_SESSION_MAX_DURATION: 3600 },
      { app: "notifications" },
    );

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/can never fire/);
  });

  it("does not apply the cap/validity rule to a fixed-session app", () => {
    const result = AuthSessionPolicyCheck(
      { JWT_VALIDITY_DURATION: 604800, JWT_SESSION_MAX_DURATION: 2592000 },
      { app: "stocktrader" },
    );

    expect(result.ok).toBe(true);
  });

  it("warns when the absolute cap is disabled while sliding renewal is expected", () => {
    const result = AuthSessionPolicyCheck(
      { JWT_VALIDITY_DURATION: 2592000, JWT_SESSION_MAX_DURATION: 0 },
      { slidingRenewal: true },
    );

    expect(result.ok).toBe(true);
    expect(result.warnings.join("\n")).toMatch(/never require a fresh login/);
  });

  it("warns when the cap equals the validity (no sliding headroom)", () => {
    const result = AuthSessionPolicyCheck(
      { JWT_VALIDITY_DURATION: 2592000, JWT_SESSION_MAX_DURATION: 2592000 },
      { app: "book-reader" },
    );

    expect(result.ok).toBe(true);
    expect(result.warnings.join("\n")).toMatch(/no headroom/);
  });

  it("rejects values that differ from the documented policy", () => {
    const result = AuthSessionPolicyCheck(
      { JWT_VALIDITY_DURATION: 3600, JWT_SESSION_MAX_DURATION: 7200 },
      { app: "notifications" },
    );

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/documented policy expects 2592000s/);
    expect(result.errors.join("\n")).toMatch(/documented policy expects 7776000s/);
  });

  it("uses explicit expected values without an app id", () => {
    const result = AuthSessionPolicyCheck(
      { JWT_VALIDITY_DURATION: 2592000, JWT_SESSION_MAX_DURATION: 2592000 },
      {
        expected: {
          validitySeconds: 2592000,
          maxDurationSeconds: 2592000,
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(result.app).toBe("unknown");
  });

  it("rejects an unknown application id", () => {
    const result = AuthSessionPolicyCheck(STANDARD, { app: "does-not-exist" });

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/Unknown application/);
  });

  it("rejects a non-finite or non-positive validity", () => {
    const notFinite = AuthSessionPolicyCheck(
      { JWT_VALIDITY_DURATION: Number.NaN, JWT_SESSION_MAX_DURATION: 0 },
      {},
    );
    expect(notFinite.ok).toBe(false);

    const notPositive = AuthSessionPolicyCheck(
      { JWT_VALIDITY_DURATION: 0, JWT_SESSION_MAX_DURATION: 0 },
      {},
    );
    expect(notPositive.ok).toBe(false);
  });

  it("rejects a non-finite cap", () => {
    const result = AuthSessionPolicyCheck(
      { JWT_VALIDITY_DURATION: 2592000, JWT_SESSION_MAX_DURATION: Number.NaN },
      {},
    );

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/JWT_SESSION_MAX_DURATION/);
  });

  it("honours a minValiditySeconds override", () => {
    const result = AuthSessionPolicyCheck(
      { JWT_VALIDITY_DURATION: 1800, JWT_SESSION_MAX_DURATION: 1800 },
      { minValiditySeconds: 900 },
    );

    expect(result.ok).toBe(true);
  });
});

describe("AuthSessionPolicyLog", () => {
  it("logs the stable policy line and returns the result", () => {
    const messages: string[] = [];

    const result = AuthSessionPolicyLog(STANDARD, {
      app: "notifications",
      logger: (message) => messages.push(message),
    });

    expect(result.ok).toBe(true);
    expect(messages).toEqual([
      "Auth session policy: app=notifications validity=2592000s cap=7776000s renewal=sliding status=ok",
    ]);
  });

  it("accepts a logger object exposing info()", () => {
    const info = jest.fn();

    AuthSessionPolicyLog(STANDARD, { app: "telepathy", logger: { info } });

    expect(info).toHaveBeenCalledWith(
      "Auth session policy: app=telepathy validity=2592000s cap=7776000s renewal=sliding status=ok",
    );
  });

  it("logs error lines and reports status=error", () => {
    const messages: string[] = [];

    AuthSessionPolicyLog(
      { JWT_VALIDITY_DURATION: 60, JWT_SESSION_MAX_DURATION: 0 },
      {
        app: "notifications",
        logger: (message) => messages.push(message),
      },
    );

    expect(messages[0]).toBe(
      "Auth session policy: app=notifications validity=60s cap=0s renewal=sliding status=error",
    );
    expect(messages.some((m) => m.startsWith("Auth session policy error:"))).toBe(
      true,
    );
  });

  it("logs warning lines", () => {
    const messages: string[] = [];

    AuthSessionPolicyLog(
      { JWT_VALIDITY_DURATION: 2592000, JWT_SESSION_MAX_DURATION: 0 },
      {
        app: "notifications",
        logger: (message) => messages.push(message),
      },
    );

    expect(
      messages.some((m) => m.startsWith("Auth session policy warning:")),
    ).toBe(true);
  });

  it("throws after logging when throwOnError is set", () => {
    const logger = jest.fn();

    expect(() =>
      AuthSessionPolicyLog(
        { JWT_VALIDITY_DURATION: 60, JWT_SESSION_MAX_DURATION: 0 },
        { app: "notifications", logger, throwOnError: true },
      ),
    ).toThrow(/Auth session policy violation for app=notifications/);
    expect(logger).toHaveBeenCalled();
  });

  it("does not throw on a green check with throwOnError", () => {
    expect(() =>
      AuthSessionPolicyLog(STANDARD, {
        app: "notifications",
        logger: jest.fn(),
        throwOnError: true,
      }),
    ).not.toThrow();
  });
});

describe("AuthSessionPolicyAssert", () => {
  it("returns the result when the policy is respected", () => {
    const result = AuthSessionPolicyAssert(STANDARD, {
      app: "sourcecode-editor",
    });

    expect(result.ok).toBe(true);
  });

  it("throws every violation", () => {
    expect(() =>
      AuthSessionPolicyAssert(
        { JWT_VALIDITY_DURATION: 60, JWT_SESSION_MAX_DURATION: 30 },
        { app: "notifications" },
      ),
    ).toThrow(/minimum[\s\S]*can never fire/);
  });
});

interface TableRow {
  app: string;
  validity: number;
  maxDuration: number;
  renewal: string;
  keyPersistence: string;
  configuration: string;
}

function parsePolicyTable(markdown: string): TableRow[] {
  const lines = markdown.split("\n");
  const headerIndex = lines.findIndex((line) =>
    /^\|\s*App\s*\|\s*Validity \(s\)\s*\|/.test(line.trim()),
  );
  if (headerIndex < 0) {
    throw new Error("auth-session-policy.md: application table not found");
  }

  const rows: TableRow[] = [];
  for (const line of lines.slice(headerIndex + 1)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) {
      break;
    }
    const cells = trimmed
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim());
    if (cells.every((cell) => /^:?-+:?$/.test(cell))) {
      continue;
    }
    const validity = Number(cells[1].split(/\s+/)[0]);
    const maxDuration = Number(cells[2].split(/\s+/)[0]);
    if (cells.length !== 6 || Number.isNaN(validity) || Number.isNaN(maxDuration)) {
      throw new Error(
        `auth-session-policy.md: malformed application table row: ${trimmed}`,
      );
    }
    rows.push({
      app: cells[0],
      validity,
      maxDuration,
      renewal: cells[3],
      keyPersistence: cells[4],
      configuration: cells[5],
    });
  }
  return rows;
}

describe("docs/auth-session-policy.md", () => {
  const markdown = fs.readFileSync(
    path.resolve(__dirname, "../../docs/auth-session-policy.md"),
    "utf8",
  );
  const rows = parsePolicyTable(markdown);

  it("documents every application exactly once", () => {
    const documented = rows.map((row) => row.app);
    const mapped = Object.keys(AUTH_SESSION_POLICY_APPS);

    expect(new Set(documented).size).toBe(documented.length);
    expect(documented.sort()).toEqual(mapped.sort());
  });

  it("matches AUTH_SESSION_POLICY_APPS in both numeric cells", () => {
    for (const row of rows) {
      const app = AUTH_SESSION_POLICY_APPS[row.app];
      expect(app).toBeDefined();
      expect({ app: row.app, validity: row.validity }).toEqual({
        app: row.app,
        validity: app.validitySeconds,
      });
      expect({ app: row.app, maxDuration: row.maxDuration }).toEqual({
        app: row.app,
        maxDuration: app.maxDurationSeconds,
      });
    }
  });

  it("fills every non-numeric cell", () => {
    for (const row of rows) {
      expect(row.renewal.length).toBeGreaterThan(0);
      expect(row.keyPersistence.length).toBeGreaterThan(0);
      expect(row.configuration.length).toBeGreaterThan(0);
    }
  });

  it("records the standard rule and the required exceptions", () => {
    expect(markdown).toContain("30-day sliding validity");
    expect(markdown).toContain("90-day absolute cap");
    expect(markdown).toContain("Restic Secrets Manager");
    expect(markdown).toContain("Study Guide");
    expect(markdown).toContain("Cloud Photo Manager");
    expect(markdown).toContain("addConfigField");
    expect(markdown).toContain("Signing-key rotation");
  });

  it("marks the apps without a JWT session as not applicable", () => {
    expect(markdown).toContain("carol-contact-card");
    expect(markdown).toContain("voice-recorder");
    expect(markdown).toContain("dsc-edsembli-report");
  });
});
