import { describe, expect, it } from "vitest";
import { configSchema } from "../src/config/schema.js";
import { evaluateRules, mapFileToLayer } from "../src/rules/engine.js";
import { type Dependency } from "../src/model.js";

const layers = [
  { name: "ui", patterns: ["src/ui/**"] },
  { name: "domain", patterns: ["src/domain/**"] },
  { name: "infra", patterns: ["src/infra/**"] },
];

function dependency(overrides: Partial<Dependency> = {}): Dependency {
  return {
    importer: "src/ui/page.ts",
    specifier: "../infra/database",
    resolvedTarget: "src/infra/database.ts",
    line: 4,
    column: 1,
    kind: "import",
    external: false,
    ...overrides,
  };
}

describe("rule engine", () => {
  it("maps paths to layers and identifies ambiguous matches", () => {
    const config = configSchema.parse({ version: 1, layers });
    expect(mapFileToLayer("src/ui/page.ts", config)).toEqual({
      layer: "ui",
      ambiguous: [],
    });
    const ambiguous = configSchema.parse({
      version: 1,
      layers: [...layers, { name: "all-src", patterns: ["src/**"] }],
    });
    expect(mapFileToLayer("src/ui/page.ts", ambiguous).ambiguous).toEqual([
      "ui",
      "all-src",
    ]);
  });

  it("reports a forbidden layer boundary with remediation", () => {
    const config = configSchema.parse({
      version: 1,
      layers,
      rules: [
        {
          id: "ui-no-infra",
          type: "layer-boundary",
          severity: "error",
          from: ["ui"],
          to: ["infra"],
        },
      ],
    });
    const findings = evaluateRules([dependency()], config);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.ruleId).toBe("ui-no-infra");
    expect(findings[0]?.remediation).toContain("application-level");
  });

  it("matches forbidden import globs rather than substrings", () => {
    const config = configSchema.parse({
      version: 1,
      layers,
      rules: [
        {
          id: "no-database",
          type: "forbidden-import",
          severity: "warning",
          from: ["src/ui/**"],
          patterns: ["../infra/database"],
          match: "specifier",
        },
      ],
    });
    expect(evaluateRules([dependency()], config)).toHaveLength(1);
    expect(
      evaluateRules([dependency({ specifier: "../database-helper" })], config),
    ).toHaveLength(0);
  });

  it("enforces an allowed dependency set", () => {
    const config = configSchema.parse({
      version: 1,
      layers,
      rules: [
        {
          id: "ui-allowed",
          type: "allowed-dependency",
          severity: "error",
          from: ["src/ui/**"],
          allowed: ["domain"],
          match: "layer",
        },
      ],
    });
    expect(evaluateRules([dependency()], config)).toHaveLength(1);
    expect(
      evaluateRules(
        [
          dependency({
            specifier: "../domain/model",
            resolvedTarget: "src/domain/model.ts",
          }),
        ],
        config,
      ),
    ).toHaveLength(0);
  });

  it("reports each cycle once with a stable fingerprint", () => {
    const config = configSchema.parse({
      version: 1,
      layers,
      rules: [{ id: "no-cycles", type: "no-cycles", severity: "error" }],
    });
    const first = dependency({
      importer: "src/domain/a.ts",
      resolvedTarget: "src/domain/b.ts",
    });
    const second = dependency({
      importer: "src/domain/b.ts",
      resolvedTarget: "src/domain/a.ts",
    });
    const resultA = evaluateRules([first, second], config);
    const resultB = evaluateRules([second, first], config);
    expect(resultA).toHaveLength(1);
    expect(resultA[0]?.fingerprint).toBe(resultB[0]?.fingerprint);
  });
});
