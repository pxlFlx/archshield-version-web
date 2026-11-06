import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function tempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "archshield-test-"));
}

export async function writeFixture(
  root: string,
  relative: string,
  contents: string,
): Promise<void> {
  const destination = path.join(root, relative);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, contents, "utf8");
}
