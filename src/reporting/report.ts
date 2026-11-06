import { type ProjectAnalysis } from "../analyze.js";
import { type Finding, type Report } from "../model.js";

export const VERSION = "0.1.0";

export function createReport(
  projectName: string,
  analysis: ProjectAnalysis,
  findings: Finding[],
  durationMs: number,
): Report {
  return {
    schemaVersion: 1,
    tool: { name: "ArchShield", version: VERSION },
    project: projectName,
    durationMs: Math.max(0, Math.round(durationMs)),
    analyzedFiles: analysis.files.length,
    dependencies: {
      local: analysis.dependencies.filter(
        (dependency) =>
          !dependency.external && dependency.resolvedTarget !== null,
      ).length,
      external: analysis.dependencies.filter(
        (dependency) => dependency.external,
      ).length,
    },
    findings,
    diagnostics: analysis.diagnostics,
    summary: {
      errors: findings.filter((finding) => finding.severity === "error").length,
      warnings: findings.filter((finding) => finding.severity === "warning")
        .length,
      info: findings.filter((finding) => finding.severity === "info").length,
      new: findings.filter((finding) => finding.baselineStatus !== "existing")
        .length,
      existing: findings.filter(
        (finding) => finding.baselineStatus === "existing",
      ).length,
    },
  };
}

export function formatText(report: Report, color: boolean): string {
  const paint = (value: string, code: string): string =>
    color ? `\u001b[${code}m${value}\u001b[0m` : value;
  const lines = [
    `ArchShield ${report.tool.version}`,
    `Analyzed ${report.analyzedFiles} files in ${formatDuration(report.durationMs)}`,
    `Dependencies: ${report.dependencies.local} local edges, ${report.dependencies.external} external imports`,
    "",
  ];

  for (const finding of report.findings) {
    const severity = finding.severity.toUpperCase();
    const style =
      finding.severity === "error"
        ? "31"
        : finding.severity === "warning"
          ? "33"
          : "36";
    lines.push(`${paint(severity, style)}  ${finding.ruleId}`);
    lines.push(`${finding.importer}:${finding.line}:${finding.column}`);
    lines.push(finding.message);
    lines.push(`Why it matters: ${finding.explanation}`);
    lines.push(`Suggested fix: ${finding.remediation}`);
    if (finding.baselineStatus)
      lines.push(`Baseline: ${finding.baselineStatus}`);
    lines.push("");
  }

  for (const diagnostic of report.diagnostics) {
    const location = diagnostic.file
      ? `${diagnostic.file}${diagnostic.line ? `:${diagnostic.line}:${diagnostic.column ?? 1}` : ""}: `
      : "";
    const style =
      diagnostic.level === "error"
        ? "31"
        : diagnostic.level === "warning"
          ? "33"
          : "36";
    lines.push(
      `${paint(diagnostic.level.toUpperCase(), style)}  ${diagnostic.code}`,
    );
    lines.push(`${location}${diagnostic.message}`);
  }
  if (report.diagnostics.length > 0) lines.push("");

  lines.push(
    `Summary: ${report.summary.errors} error${report.summary.errors === 1 ? "" : "s"}, ${report.summary.warnings} warning${report.summary.warnings === 1 ? "" : "s"}, ${report.summary.info} info`,
  );
  if (report.summary.existing > 0) {
    lines.push(
      `Baseline: ${report.summary.new} new, ${report.summary.existing} existing`,
    );
  }
  return lines.join("\n");
}

export function formatSarif(report: Report): string {
  const rules = [...new Set(report.findings.map((finding) => finding.ruleId))]
    .sort()
    .map((id) => ({ id, shortDescription: { text: id } }));
  const results = report.findings.map((finding) => ({
    ruleId: finding.ruleId,
    level:
      finding.severity === "error"
        ? "error"
        : finding.severity === "warning"
          ? "warning"
          : "note",
    message: { text: `${finding.message} ${finding.remediation}` },
    partialFingerprints: { archshieldFingerprint: finding.fingerprint },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: finding.importer },
          region: {
            startLine: finding.line,
            startColumn: finding.column,
          },
        },
      },
    ],
  }));
  return JSON.stringify(
    {
      version: "2.1.0",
      $schema: "https://json.schemastore.org/sarif-2.1.0.json",
      runs: [
        {
          tool: {
            driver: {
              name: "ArchShield",
              semanticVersion: report.tool.version,
              rules,
            },
          },
          results,
        },
      ],
    },
    null,
    2,
  );
}

function formatDuration(milliseconds: number): string {
  return milliseconds < 1000
    ? `${milliseconds} ms`
    : `${(milliseconds / 1000).toFixed(2)}s`;
}
