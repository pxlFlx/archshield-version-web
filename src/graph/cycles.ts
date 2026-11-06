import { type Dependency } from "../model.js";
import { compareText } from "../core/sort.js";

function canonicalCycle(cycle: string[]): string[] {
  const body = cycle.slice(0, -1);
  if (body.length === 0) return cycle;
  let smallest = 0;
  for (let index = 1; index < body.length; index += 1) {
    if (compareText(body[index] ?? "", body[smallest] ?? "") < 0)
      smallest = index;
  }
  const ordered = [...body.slice(smallest), ...body.slice(0, smallest)];
  return [...ordered, ordered[0] ?? ""];
}

export function findCycles(dependencies: Dependency[]): string[][] {
  const graph = new Map<string, Set<string>>();
  for (const dependency of dependencies) {
    if (dependency.resolvedTarget === null || dependency.external) continue;
    const targets = graph.get(dependency.importer) ?? new Set<string>();
    targets.add(dependency.resolvedTarget);
    graph.set(dependency.importer, targets);
  }

  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const cycles = new Map<string, string[]>();
  const visit = (node: string): void => {
    state.set(node, 1);
    stack.push(node);
    for (const target of [...(graph.get(node) ?? [])].sort()) {
      if (state.get(target) === 1) {
        const start = stack.lastIndexOf(target);
        if (start >= 0) {
          const cycle = canonicalCycle([...stack.slice(start), target]);
          cycles.set(cycle.join(" -> "), cycle);
        }
      } else if (!state.has(target)) {
        visit(target);
      }
    }
    stack.pop();
    state.set(node, 2);
  };

  for (const node of [...graph.keys()].sort()) {
    if (!state.has(node)) visit(node);
  }
  return [...cycles.values()].sort((a, b) =>
    compareText(a.join(" -> "), b.join(" -> ")),
  );
}
