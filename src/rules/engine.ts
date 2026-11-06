import { createHash } from "node:crypto";
import path from "node:path";
import picomatch from "picomatch";
import {
  type ArchShieldConfig,
  type ArchShieldRule,
} from "../config/schema.js";
import { findCycles } from "../graph/cycles.js";
import { type Dependency, type Finding } from "../model.js";
import { compareText } from "../core/sort.js";

function matchesAny(
  value: string,
  patterns: string[],
  caseSensitive = true,
): boolean {
  return patterns.some((pattern) =>
    picomatch(pattern, { dot: true, nocase: !caseSensitive })(value),
  );
}

function normalizePath(value: string): string {
  return value.split(path.sep).join("/").replace(/^\.\//, "");
}

export function mapFileToLayer(
  file: string,
  config: ArchShieldConfig,
): { layer: string | null; ambiguous: string[] } {
  const matches = config.layers
    .filter((layer) =>
      matchesAny(
        normalizePath(file),
        layer.patterns,
        config.settings.caseSensitivePaths,
      ),
    )
    .map((layer) => layer.name);
  if (matches.length > 1 && config.settings.allowAmbiguousLayers) {
    return { layer: matches[0] ?? null, ambiguous: [] };
  }
  return {
    layer: matches.length === 1 ? (matches[0] ?? null) : null,
    ambiguous: matches.length > 1 ? matches : [],
  };
}

function fingerprint(ruleId: string, importer: string, target: string): string {
  return createHash("sha256")
    .update([ruleId, normalizePath(importer), normalizePath(target)].join("\0"))
    .digest("hex")
    .slice(0, 32);
}

function finding(
  rule: ArchShieldRule,
  dependency: Dependency,
  title: string,
  message: string,
  explanation: string,
  remediation: string,
): Finding {
  return {
    ruleId: rule.id,
    severity: rule.severity,
    title,
    message,
    importer: dependency.importer,
    target: dependency.resolvedTarget ?? dependency.specifier,
    line: dependency.line,
    column: dependency.column,
    explanation,
    remediation,
    fingerprint: fingerprint(
      rule.id,
      dependency.importer,
      dependency.resolvedTarget ?? dependency.specifier,
    ),
  };
}

function ruleAppliesToImporter(
  importer: string,
  patterns: string[],
  config: ArchShieldConfig,
): boolean {
  return matchesAny(
    normalizePath(importer),
    patterns,
    config.settings.caseSensitivePaths,
  );
}

function matchesDependencySelector(
  dependency: Dependency,
  selector: string,
  mode: "layer" | "path" | "both",
  targetLayer: string | null,
  config: ArchShieldConfig,
): boolean {
  const pathMatch =
    (mode === "path" || mode === "both") &&
    (matchesAny(
      dependency.specifier,
      [selector],
      config.settings.caseSensitivePaths,
    ) ||
      (dependency.resolvedTarget !== null &&
        matchesAny(
          normalizePath(dependency.resolvedTarget),
          [selector],
          config.settings.caseSensitivePaths,
        )));
  const layerMatch =
    (mode === "layer" || mode === "both") && targetLayer === selector;
  return pathMatch || layerMatch;
}

function detectLayerAmbiguities(
  dependencies: Dependency[],
  config: ArchShieldConfig,
): Finding[] {
  const ambiguousFiles = new Set<string>();
  for (const dependency of dependencies) {
    ambiguousFiles.add(dependency.importer);
    if (dependency.resolvedTarget)
      ambiguousFiles.add(dependency.resolvedTarget);
  }
  for (const file of ambiguousFiles) {
    const mapped = mapFileToLayer(file, config);
    if (mapped.ambiguous.length > 1) {
      throw new Error(
        `File "${file}" matches multiple layers (${mapped.ambiguous.join(", ")}). Fix the patterns or set settings.allowAmbiguousLayers to true.`,
      );
    }
  }
  return [];
}

export function evaluateRules(
  dependencies: Dependency[],
  config: ArchShieldConfig,
): Finding[] {
  detectLayerAmbiguities(dependencies, config);
  const findings: Finding[] = [];

  for (const rule of config.rules) {
    if (rule.type === "no-cycles") {
      for (const cycle of findCycles(dependencies)) {
        const importer = cycle[0];
        const target = cycle[1];
        if (!importer || !target) continue;
        const edge = dependencies.find(
          (dependency) =>
            dependency.importer === importer &&
            dependency.resolvedTarget === target,
        );
        if (!edge) continue;
        findings.push(
          finding(
            rule,
            edge,
            "Circular dependency",
            rule.message ?? `Cycle detected: ${cycle.join(" → ")}`,
            "Cycles make module initialization and change impact harder to reason about.",
            "Break the cycle by extracting shared code into a lower-level module or reversing the dependency.",
          ),
        );
      }
      continue;
    }

    for (const dependency of dependencies) {
      if (rule.type === "layer-boundary") {
        const sourceLayer = mapFileToLayer(dependency.importer, config).layer;
        const targetLayer = dependency.resolvedTarget
          ? mapFileToLayer(dependency.resolvedTarget, config).layer
          : null;
        if (
          sourceLayer &&
          targetLayer &&
          rule.from.includes(sourceLayer) &&
          rule.to.includes(targetLayer)
        ) {
          findings.push(
            finding(
              rule,
              dependency,
              "Layer boundary violation",
              rule.message ??
                `${sourceLayer} must not depend on ${targetLayer}.`,
              "A direct dependency across this boundary couples layers and makes changes harder to isolate.",
              "Move the dependency behind an application-level interface or service.",
            ),
          );
        }
      } else if (rule.type === "forbidden-import") {
        if (!ruleAppliesToImporter(dependency.importer, rule.from, config))
          continue;
        const specifierMatch =
          (rule.match === "specifier" || rule.match === "both") &&
          matchesAny(
            dependency.specifier,
            rule.patterns,
            config.settings.caseSensitivePaths,
          );
        const pathMatch =
          (rule.match === "path" || rule.match === "both") &&
          dependency.resolvedTarget !== null &&
          matchesAny(
            normalizePath(dependency.resolvedTarget),
            rule.patterns,
            config.settings.caseSensitivePaths,
          );
        if (specifierMatch || pathMatch) {
          findings.push(
            finding(
              rule,
              dependency,
              "Forbidden import",
              rule.message ??
                `Import "${dependency.specifier}" is not allowed here.`,
              "This dependency matches a forbidden import pattern.",
              "Remove the import or move the needed behavior behind an allowed module boundary.",
            ),
          );
        }
      } else if (rule.type === "allowed-dependency") {
        if (!ruleAppliesToImporter(dependency.importer, rule.from, config))
          continue;
        const targetLayer = dependency.resolvedTarget
          ? mapFileToLayer(dependency.resolvedTarget, config).layer
          : null;
        const allowed = rule.allowed.some((selector) =>
          matchesDependencySelector(
            dependency,
            selector,
            rule.match,
            targetLayer,
            config,
          ),
        );
        if (!allowed) {
          findings.push(
            finding(
              rule,
              dependency,
              "Dependency is outside the allowed set",
              rule.message ??
                `Dependency "${dependency.specifier}" is not explicitly allowed.`,
              "This module is restricted to a declared dependency set, keeping its boundary explicit.",
              "Add the dependency to the rule only if the boundary is intentional, or move the import to an allowed module.",
            ),
          );
        }
      }
    }
  }

  const unique = new Map<string, Finding>();
  for (const item of findings) {
    unique.set(
      `${item.ruleId}\0${item.importer}\0${item.line}\0${item.target}`,
      item,
    );
  }
  return [...unique.values()].sort(
    (a, b) =>
      severityRank(a.severity) - severityRank(b.severity) ||
      compareText(a.importer, b.importer) ||
      a.line - b.line ||
      compareText(a.ruleId, b.ruleId),
  );
}

function severityRank(severity: Finding["severity"]): number {
  return severity === "error" ? 0 : severity === "warning" ? 1 : 2;
}
