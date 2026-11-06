import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeFixture } from "./helpers.js";

const cliPath = path.resolve("dist/cli.js");

const config = {
  version: 1,
  project: { name: "fixture", root: "." },
  include: ["src/**/*.{ts,tsx,js,jsx,mjs,cjs}"],
  exclude: ["src/generated/**"],
  layers: [
    { name: "presentation", patterns: ["src/presentation/**"] },
    { name: "infrastructure", patterns: ["src/infrastructure/**"] },
  ],
  rules: [
    {
      id: "presentation-no-infrastructure",
      type: "layer-boundary",
      severity: "error",
      from: ["presentation"],
      to: ["infrastructure"],
    },
  ],
  settings: { unresolvedImports: "ignore" },
};

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "archshield-cli-"));
  await writeFile(
    path.join(root, "archshield.json"),
    JSON.stringify(config, null, 2),
  );
  return root;
}

function run(root: string, ...args: string[]) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
  });
}

describe("CLI integration", () => {
  it("passes a clean fixture with exit code 0", async () => {
    const root = await fixture();
    await writeFixture(
      root,
      "src/presentation/page.ts",
      "export const ok = true;\n",
    );
    const result = run(root, "check");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Summary: 0 errors");
  });

  it("fails a violating fixture with exit code 1", async () => {
    const root = await fixture();
    await writeFixture(
      root,
      "src/presentation/page.ts",
      'import "../infrastructure/db";\n',
    );
    await writeFixture(root, "src/infrastructure/db.ts", "export {};\n");
    const result = run(root, "check");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("presentation-no-infrastructure");
  });

  it("returns exit code 2 and a useful message for invalid configuration", async () => {
    const root = await fixture();
    await writeFile(
      path.join(root, "archshield.json"),
      '{"version":1,"unknown":true}',
    );
    const result = run(root, "check");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Invalid ArchShield config");
  });

  it("prints valid JSON containing findings", async () => {
    const root = await fixture();
    await writeFixture(
      root,
      "src/presentation/page.ts",
      'import "../infrastructure/db";\n',
    );
    await writeFixture(root, "src/infrastructure/db.ts", "export {};\n");
    const result = run(root, "check", "--format", "json");
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).findings[0].ruleId).toBe(
      "presentation-no-infrastructure",
    );
  });

  it("ignores baseline findings but still fails on a new finding", async () => {
    const root = await fixture();
    await writeFixture(
      root,
      "src/presentation/page.ts",
      'import "../infrastructure/db";\n',
    );
    await writeFixture(root, "src/infrastructure/db.ts", "export {};\n");
    const first = run(root, "check", "--update-baseline");
    expect(first.status).toBe(0);
    const baseline = JSON.parse(
      await readFile(path.join(root, ".archshield-baseline.json"), "utf8"),
    );
    expect(baseline.fingerprints).toHaveLength(1);

    await writeFixture(
      root,
      "src/presentation/other.ts",
      'import "../infrastructure/db";\n',
    );
    const second = run(
      root,
      "check",
      "--baseline",
      ".archshield-baseline.json",
    );
    expect(second.status).toBe(1);
    expect(second.stdout).toContain("new");
    expect(second.stdout).toContain("existing");
  });

  it("excludes configured files from analysis", async () => {
    const root = await fixture();
    await writeFixture(
      root,
      "src/generated/bad.ts",
      'import "../infrastructure/db";\n',
    );
    await writeFixture(root, "src/infrastructure/db.ts", "export {};\n");
    const result = run(root, "check");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Analyzed 1 files");
  });

  it("reports unsupported language adapters with exit code 2", async () => {
    const root = await fixture();
    await writeFile(
      path.join(root, "archshield.json"),
      JSON.stringify({
        ...config,
        languages: { python: { enabled: true } },
      }),
    );
    const result = run(root, "check");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Python analysis is not implemented");
  });

  it("does not overwrite an init config unless forced", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "archshield-init-"));
    await writeFile(path.join(root, "archshield.json"), "keep me\n");
    const refused = run(root, "init");
    expect(refused.status).toBe(2);
    expect(await readFile(path.join(root, "archshield.json"), "utf8")).toBe(
      "keep me\n",
    );
    const forced = run(root, "init", "--force", "--preset", "react");
    expect(forced.status).toBe(0);
    expect(
      JSON.parse(await readFile(path.join(root, "archshield.json"), "utf8"))
        .project.name,
    ).toBe("react-app");
  });

  it("generates deterministic Mermaid graph output", async () => {
    const root = await fixture();
    await writeFixture(
      root,
      "src/presentation/page.ts",
      'import "../infrastructure/db";\n',
    );
    await writeFixture(root, "src/infrastructure/db.ts", "export {};\n");
    const first = run(root, "graph", "--format", "mermaid");
    const second = run(root, "graph", "--format", "mermaid");
    expect(first.status).toBe(0);
    expect(first.stdout).toBe(second.stdout);
    expect(first.stdout).toContain("flowchart LR");
  });

  it("filters changed-file findings and explains a missing base ref", async () => {
    const root = await fixture();
    const git = (...args: string[]) =>
      spawnSync("git", args, { cwd: root, encoding: "utf8" });
    expect(git("init", "-q").status).toBe(0);
    git("config", "user.name", "ArchShield Tests");
    git("config", "user.email", "tests@example.test");
    await writeFixture(
      root,
      "src/presentation/page.ts",
      "export const ok = true;\n",
    );
    await writeFixture(root, "src/infrastructure/db.ts", "export {};\n");
    git("add", ".");
    git("commit", "-qm", "baseline");
    const base = git("rev-parse", "HEAD").stdout.trim();
    await writeFixture(
      root,
      "src/presentation/page.ts",
      'import "../infrastructure/db";\n',
    );
    git("add", ".");
    git("commit", "-qm", "introduce violation");

    const changed = run(root, "check", "--changed-only", "--base", base);
    expect(changed.status).toBe(1);
    expect(changed.stdout).toContain("presentation-no-infrastructure");

    const missingBase = run(
      root,
      "check",
      "--changed-only",
      "--base",
      "not-a-real-ref",
    );
    expect(missingBase.status).toBe(2);
    expect(missingBase.stderr).toContain("Fetch the ref");
  });

  it("returns exit code 2 for invalid CLI options", async () => {
    const root = await fixture();
    const result = run(root, "check", "--format", "yaml");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Unknown report format");
  });

  it("continues after malformed source instead of crashing", async () => {
    const root = await fixture();
    await writeFixture(
      root,
      "src/presentation/broken.ts",
      "import { from './oops';\n",
    );
    const result = run(root, "check", "--format", "json");
    expect(result.status).toBe(0);
    expect(
      JSON.parse(result.stdout).diagnostics.some(
        (item: { code: string }) => item.code === "SOURCE_PARSE",
      ),
    ).toBe(true);
  });
});
