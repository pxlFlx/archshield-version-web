import { createHash } from "node:crypto";
import { type Dependency } from "../model.js";
import { compareText } from "../core/sort.js";

function nodeId(path: string): string {
  return `n${createHash("sha1").update(path).digest("hex").slice(0, 10)}`;
}

function escapeMermaid(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "#quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeDot(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n");
}

export function formatGraph(
  dependencies: Dependency[],
  format: "mermaid" | "dot",
  includeExternal: boolean,
): string {
  const edges = dependencies
    .filter(
      (dependency) =>
        dependency.resolvedTarget !== null ||
        (includeExternal && dependency.external),
    )
    .map((dependency) => ({
      source: dependency.importer,
      target: dependency.resolvedTarget ?? `package:${dependency.specifier}`,
    }))
    .sort(
      (a, b) =>
        compareText(a.source, b.source) || compareText(a.target, b.target),
    );
  const nodes = [
    ...new Set(edges.flatMap((edge) => [edge.source, edge.target])),
  ].sort();

  if (format === "mermaid") {
    const lines = ["flowchart LR"];
    for (const node of nodes)
      lines.push(`  ${nodeId(node)}["${escapeMermaid(node)}"]`);
    for (const edge of edges)
      lines.push(`  ${nodeId(edge.source)} --> ${nodeId(edge.target)}`);
    return `${lines.join("\n")}\n`;
  }

  const lines = ["digraph ArchShield {"];
  for (const node of nodes)
    lines.push(`  "${nodeId(node)}" [label="${escapeDot(node)}"];`);
  for (const edge of edges)
    lines.push(`  "${nodeId(edge.source)}" -> "${nodeId(edge.target)}";`);
  lines.push("}");
  return `${lines.join("\n")}\n`;
}
