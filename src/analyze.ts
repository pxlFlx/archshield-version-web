import { type LoadedConfig } from "./config/load.js";
import { discoverFiles } from "./discovery/files.js";
import { extractDependencies } from "./analyzers/typescript.js";
import { evaluateRules } from "./rules/engine.js";
import { type AnalysisResult, type Diagnostic, type Finding } from "./model.js";
import { compareText } from "./core/sort.js";

export interface ProjectAnalysis extends AnalysisResult {
  findings: Finding[];
}

export async function analyzeProject(
  loaded: LoadedConfig,
): Promise<ProjectAnalysis> {
  const discovery = await discoverFiles(loaded.projectRoot, loaded.config);
  const extraction = await extractDependencies(
    loaded.projectRoot,
    discovery.files,
    loaded.config,
  );
  const diagnostics: Diagnostic[] = [
    ...discovery.diagnostics,
    ...extraction.diagnostics,
  ];
  let findings: Finding[] = [];

  try {
    findings = evaluateRules(extraction.dependencies, loaded.config);
  } catch (error) {
    diagnostics.push({
      code: "ANALYSIS_FATAL",
      level: "error",
      message:
        error instanceof Error ? error.message : "Rule evaluation failed.",
    });
  }

  return {
    files: discovery.files,
    dependencies: extraction.dependencies,
    findings,
    diagnostics: diagnostics.sort(
      (a, b) =>
        compareText(a.file ?? "", b.file ?? "") ||
        (a.line ?? 0) - (b.line ?? 0) ||
        compareText(a.code, b.code),
    ),
  };
}
