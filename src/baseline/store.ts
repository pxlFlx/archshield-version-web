import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { type Finding } from "../model.js";

const baselineSchema = z
  .object({
    version: z.literal(1),
    fingerprints: z.array(z.string().regex(/^[a-f0-9]{32}$/)),
  })
  .strict();

export class BaselineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BaselineError";
  }
}

export async function readBaseline(filePath: string): Promise<Set<string>> {
  let contents: string;
  try {
    contents = await readFile(filePath, "utf8");
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return new Set();
    }
    throw new BaselineError(`Cannot read baseline "${filePath}".`);
  }

  let value: unknown;
  try {
    value = JSON.parse(contents) as unknown;
  } catch {
    throw new BaselineError(`Baseline "${filePath}" is not valid JSON.`);
  }
  const parsed = baselineSchema.safeParse(value);
  if (!parsed.success) {
    throw new BaselineError(
      `Baseline "${filePath}" has an invalid format: ${parsed.error.issues[0]?.message ?? "validation failed"}.`,
    );
  }
  return new Set(parsed.data.fingerprints);
}

export function markBaselineStatus(
  findings: Finding[],
  baseline: Set<string>,
): Finding[] {
  return findings.map((finding) => ({
    ...finding,
    baselineStatus: baseline.has(finding.fingerprint) ? "existing" : "new",
  }));
}

export async function writeBaseline(
  filePath: string,
  findings: Finding[],
): Promise<void> {
  const absolute = path.resolve(filePath);
  await mkdir(path.dirname(absolute), { recursive: true });
  const fingerprints = [
    ...new Set(findings.map((finding) => finding.fingerprint)),
  ].sort();
  await writeFile(
    absolute,
    `${JSON.stringify({ version: 1, fingerprints }, null, 2)}\n`,
    "utf8",
  );
}
