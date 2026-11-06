import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractDependencies } from "../src/analyzers/typescript.js";
import { configSchema } from "../src/config/schema.js";
import { tempDir, writeFixture } from "./helpers.js";

const config = configSchema.parse({
  version: 1,
  include: ["src/**/*.ts"],
  settings: { unresolvedImports: "ignore" },
});

describe("TypeScript and JavaScript dependency extraction", () => {
  it("extracts imports, re-exports, dynamic imports, and literal require calls", async () => {
    const root = await tempDir();
    await writeFixture(
      root,
      "src/index.ts",
      [
        'import "./feature";',
        'export { value } from "./feature";',
        'void import("./lazy");',
        'const other = require("./common");',
        'const notAnImport = "import(\\\"fake\\\")";',
        '// require("./comment")',
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/feature/index.ts",
      "export const value = 1;\n",
    );
    await writeFixture(root, "src/lazy.ts", "export {};\n");
    await writeFixture(root, "src/common.ts", "export {};\n");

    const result = await extractDependencies(root, ["src/index.ts"], config);
    expect(result.dependencies.map((item) => item.kind)).toEqual([
      "import",
      "re-export",
      "dynamic-import",
      "require",
    ]);
    expect(result.dependencies.map((item) => item.resolvedTarget)).toEqual([
      "src/feature/index.ts",
      "src/feature/index.ts",
      "src/lazy.ts",
      "src/common.ts",
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  it("distinguishes local dependencies from package imports", async () => {
    const root = await tempDir();
    await writeFixture(
      root,
      "src/index.ts",
      'import "tiny-package";\nimport "./local";\n',
    );
    await writeFixture(root, "src/local.ts", "export {};\n");
    const result = await extractDependencies(root, ["src/index.ts"], config);
    expect(
      result.dependencies.find((item) => item.specifier === "tiny-package")
        ?.external,
    ).toBe(true);
    expect(
      result.dependencies.find((item) => item.specifier === "./local")
        ?.external,
    ).toBe(false);
  });

  it("resolves tsconfig aliases and reports unresolved local aliases", async () => {
    const root = await tempDir();
    await writeFixture(
      root,
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: { "@/*": ["src/*"] },
        },
      }),
    );
    await writeFixture(
      root,
      "src/index.ts",
      'import "@/found";\nimport "@/missing";\n',
    );
    await writeFixture(root, "src/found.ts", "export {};\n");
    const warnConfig = configSchema.parse({
      version: 1,
      settings: { unresolvedImports: "warn" },
    });
    const result = await extractDependencies(
      root,
      ["src/index.ts"],
      warnConfig,
    );
    expect(result.dependencies[0]?.resolvedTarget).toBe("src/found.ts");
    expect(
      result.diagnostics.some((item) => item.code === "IMPORT_UNRESOLVED"),
    ).toBe(true);
  });

  it("continues after malformed source and reports a parse diagnostic", async () => {
    const root = await tempDir();
    await writeFixture(root, "src/broken.ts", "import { from './missing';\n");
    const result = await extractDependencies(root, ["src/broken.ts"], config);
    expect(
      result.diagnostics.some((item) => item.code === "SOURCE_PARSE"),
    ).toBe(true);
    expect(result.dependencies).toHaveLength(1);
  });

  it("does not return paths outside the project as local targets", async () => {
    const root = await tempDir();
    const outside = path.resolve(root, "../other-project/file.ts");
    await writeFixture(root, "src/index.ts", `import "${outside}";\n`);
    const result = await extractDependencies(root, ["src/index.ts"], config);
    expect(result.dependencies[0]?.resolvedTarget).toBeNull();
  });
});
