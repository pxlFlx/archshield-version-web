import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { configSchema } from "../src/config/schema.js";
import { discoverFiles } from "../src/discovery/files.js";
import { writeFixture } from "./helpers.js";

describe("file discovery", () => {
  it("respects configured exclusions and .gitignore", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "archshield-discovery-"));
    await writeFile(path.join(root, ".gitignore"), "ignored.ts\n");
    await writeFixture(root, "src/kept.ts", "export {};\n");
    await writeFixture(root, "src/ignored.ts", "export {};\n");
    await writeFixture(root, "src/generated/build.ts", "export {};\n");
    const config = configSchema.parse({
      version: 1,
      include: ["src/**/*.ts"],
      exclude: ["src/generated/**"],
    });
    const result = await discoverFiles(root, config);
    expect(result.files).toEqual(["src/kept.ts"]);
  });

  it("skips oversized files with an actionable diagnostic", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "archshield-size-"));
    await writeFixture(root, "src/large.ts", "x".repeat(2048));
    const config = configSchema.parse({
      version: 1,
      include: ["src/**/*.ts"],
      settings: { maxFileSizeKb: 1 },
    });
    const result = await discoverFiles(root, config);
    expect(result.files).toEqual([]);
    expect(result.diagnostics[0]?.code).toBe("FILE_TOO_LARGE");
  });
});
