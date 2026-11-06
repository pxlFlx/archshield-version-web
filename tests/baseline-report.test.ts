import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  markBaselineStatus,
  readBaseline,
  writeBaseline,
} from "../src/baseline/store.js";
import {
  createReport,
  formatText,
  formatSarif,
} from "../src/reporting/report.js";
import { formatGraph } from "../src/reporting/graph.js";
import { type Dependency, type Finding } from "../src/model.js";

const finding: Finding = {
  ruleId: "ui-no-db",
  severity: "error",
  title: "Boundary violation",
  message: "UI must not import database.",
  importer: "src/ui/page.ts",
  target: "src/db/client.ts",
  line: 2,
  column: 1,
  explanation: "This couples presentation to storage.",
  remediation: "Call an application service.",
  fingerprint: "0123456789abcdef0123456789abcdef",
};

describe("baseline and reports", () => {
  it("writes and reads stable baseline fingerprints", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "archshield-baseline-"));
    const file = path.join(root, "baseline.json");
    await writeBaseline(file, [finding, finding]);
    expect(await readBaseline(file)).toEqual(new Set([finding.fingerprint]));
    expect(
      markBaselineStatus([finding], new Set([finding.fingerprint]))[0]
        ?.baselineStatus,
    ).toBe("existing");
  });

  it("sorts findings and emits valid JSON and SARIF", () => {
    const analysis = {
      files: [],
      dependencies: [],
      diagnostics: [],
      findings: [],
    };
    const report = createReport("demo", analysis, [finding], 3.4);
    expect(JSON.parse(JSON.stringify(report)).findings[0].ruleId).toBe(
      "ui-no-db",
    );
    expect(JSON.parse(formatSarif(report)).runs[0].results[0].ruleId).toBe(
      "ui-no-db",
    );
    expect(formatText(report, false)).toContain(
      "Suggested fix: Call an application service.",
    );
  });

  it("writes deterministic Mermaid and DOT graph output", () => {
    const edge: Dependency = {
      importer: "src/a.ts",
      specifier: "./b",
      resolvedTarget: "src/b.ts",
      line: 1,
      column: 1,
      kind: "import",
      external: false,
    };
    expect(formatGraph([edge], "mermaid", false)).toBe(
      formatGraph([edge], "mermaid", false),
    );
    expect(formatGraph([edge], "dot", false)).toContain("digraph ArchShield");
  });
});
