export type Severity = "error" | "warning" | "info";
export type DependencyKind =
  "import" | "re-export" | "dynamic-import" | "require";
export type DiagnosticLevel = "error" | "warning" | "info";

export interface Dependency {
  importer: string;
  specifier: string;
  resolvedTarget: string | null;
  line: number;
  column: number;
  kind: DependencyKind;
  external: boolean;
}

export interface Diagnostic {
  code: string;
  level: DiagnosticLevel;
  message: string;
  file?: string;
  line?: number;
  column?: number;
}

export interface Finding {
  ruleId: string;
  severity: Severity;
  title: string;
  message: string;
  importer: string;
  target: string;
  line: number;
  column: number;
  explanation: string;
  remediation: string;
  fingerprint: string;
  baselineStatus?: "new" | "existing";
}

export interface AnalysisResult {
  files: string[];
  dependencies: Dependency[];
  diagnostics: Diagnostic[];
}

export interface Report {
  schemaVersion: 1;
  tool: {
    name: "ArchShield";
    version: string;
  };
  project: string;
  durationMs: number;
  analyzedFiles: number;
  dependencies: {
    local: number;
    external: number;
  };
  findings: Finding[];
  diagnostics: Diagnostic[];
  summary: {
    errors: number;
    warnings: number;
    info: number;
    new: number;
    existing: number;
  };
}
