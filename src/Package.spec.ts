import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

const repoRoot = path.resolve(__dirname, "..");

function npmPackFiles(): string[] {
  const output = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const result = JSON.parse(output) as { files: { path: string }[] }[];
  return result[0].files.map((f) => f.path);
}

describe("Packaging", () => {
  const indexPath = path.join(repoRoot, "dist", "index.js");
  let placeholderCreated = false;

  beforeAll(() => {
    // CI runs the tests before the build: make sure the entry point
    // advertised by the `files` whitelist exists for `npm pack` to include.
    if (!fs.existsSync(indexPath)) {
      fs.mkdirSync(path.dirname(indexPath), { recursive: true });
      fs.writeFileSync(indexPath, "");
      placeholderCreated = true;
    }
  });

  afterAll(() => {
    if (placeholderCreated) {
      fs.rmSync(indexPath, { force: true });
    }
  });

  it("ships only the compiled output, not sources, specs or workflows", () => {
    const files = npmPackFiles();
    expect(files).toContain("package.json");
    expect(files.some((f) => f.startsWith("dist/"))).toBe(true);
    expect(files.some((f) => f.startsWith("src/"))).toBe(false);
    expect(files.some((f) => f.endsWith(".spec.ts"))).toBe(false);
    expect(files.some((f) => f.startsWith(".github/"))).toBe(false);
    expect(files.some((f) => f.startsWith("coverage/"))).toBe(false);
    expect(files.some((f) => f.startsWith("node_modules/"))).toBe(false);
  });

  it("declares the export map, files whitelist and engines floor", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
    );
    expect(pkg.files).toEqual(["dist"]);
    expect(pkg.main).toBe("dist/index.js");
    expect(pkg.types).toBe("dist/index.d.ts");
    expect(pkg.exports["."]).toEqual({
      types: "./dist/index.d.ts",
      default: "./dist/index.js",
    });
    expect(pkg.exports["./package.json"]).toBe("./package.json");
    const subpaths = [
      "./otel",
      "./config",
      "./db",
      "./db/sqlite",
      "./db/postgres",
      "./db/no-telemetry",
      "./users",
      "./notifications",
      "./llm",
      "./system",
      "./timeout",
    ];
    for (const subpath of subpaths) {
      expect(pkg.exports[subpath]).toBeDefined();
      expect(
        (pkg.exports[subpath].types as string).startsWith("./dist/"),
      ).toBe(true);
      expect(
        (pkg.exports[subpath].default as string).startsWith("./dist/"),
      ).toBe(true);
    }
    expect(pkg.engines.node).toBe(">=22");
  });

  it("resolves every export target to a compiled source file", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
    );
    // dist/ mirrors the layout: dist/index.js <- index.ts,
    // dist/src/<x>.js <- src/<x>.ts
    for (const target of Object.values(pkg.exports)) {
      if (typeof target !== "object") {
        continue;
      }
      for (const file of Object.values(target as Record<string, string>)) {
        const compiled = (file as string).replace(/^\.\/dist\//, "");
        const source = (
          compiled.startsWith("src/") ? compiled : path.basename(compiled)
        ).replace(/\.d\.ts$/, ".ts").replace(/\.js$/, ".ts");
        expect(fs.existsSync(path.join(repoRoot, source))).toBe(true);
      }
    }
  });
});
