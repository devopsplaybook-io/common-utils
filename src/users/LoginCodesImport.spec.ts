import * as path from "path";
import * as loginCodes from "./login-codes";

// The login-code entry point must stay importable by custom-auth servers that
// do not use the common-utils database facade: importing it must not load a
// database driver. Keep this spec free of other common-utils imports so the
// module registry only contains what this entry point pulls in.
describe("login-codes entry point", () => {
  it("exports the protocol surface", () => {
    expect(typeof loginCodes.LoginCodesRoutes).toBe("function");
    expect(typeof loginCodes.createLoginCodesStoreCommonUtils).toBe("function");
    expect(typeof loginCodes.LoginCodesOptionsFromConfig).toBe("function");
    expect(typeof loginCodes.LoginCodeGenerateCode).toBe("function");
    expect(
      (loginCodes as unknown as Record<string, unknown>)
        .runLoginCodesStoreConformance,
    ).toBeUndefined();
  });

  it("does not load better-sqlite3 or pg", () => {
    const loadedModules = Object.keys(require.cache);
    expect(
      loadedModules.filter((modulePath) =>
        modulePath.includes(`${path.sep}better-sqlite3${path.sep}`),
      ),
    ).toEqual([]);
    expect(
      loadedModules.filter((modulePath) =>
        modulePath.includes(`${path.sep}pg${path.sep}`),
      ),
    ).toEqual([]);
  });
});
