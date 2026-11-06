import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import ignore, { type Ignore } from "ignore";
import { type ArchShieldConfig } from "../config/schema.js";
import { type Diagnostic } from "../model.js";

const SUPPORTED_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

interface IgnoreFile {
  directory: string;
  matcher: Ignore;
}

export interface DiscoveryResult {
  files: string[];
  diagnostics: Diagnostic[];
}

async function loadGitIgnores(root: string): Promise<IgnoreFile[]> {
  const paths = await fg("**/.gitignore", {
    cwd: root,
    dot: true,
    onlyFiles: true,
    followSymbolicLinks: false,
    ignore: ["**/node_modules/**", "**/.git/**"],
  });
  const ignores: IgnoreFile[] = [];
  for (const relative of paths.sort()) {
    const absolute = path.join(root, relative);
    const contents = await readFile(absolute, "utf8").catch(() => "");
    if (contents.length === 0) continue;
    ignores.push({
      directory: path.dirname(relative) === "." ? "" : path.dirname(relative),
      matcher: ignore().add(contents),
    });
  }
  return ignores;
}

function isGitIgnored(file: string, ignoreFiles: IgnoreFile[]): boolean {
  const normalized = file.split(path.sep).join("/");
  return ignoreFiles.some(({ directory, matcher }) => {
    if (
      directory &&
      normalized !== directory &&
      !normalized.startsWith(`${directory}/`)
    ) {
      return false;
    }
    const relative = directory
      ? normalized.slice(directory.length + 1)
      : normalized;
    return matcher.test(relative).ignored;
  });
}

export async function discoverFiles(
  root: string,
  config: ArchShieldConfig,
): Promise<DiscoveryResult> {
  const diagnostics: Diagnostic[] = [];
  const ignoredByGit = await loadGitIgnores(root);
  const candidates = await fg(config.include, {
    cwd: root,
    onlyFiles: true,
    dot: true,
    followSymbolicLinks: config.settings.followSymlinks,
    ignore: config.exclude,
    unique: true,
  });
  const files: string[] = [];

  for (const relative of candidates.sort()) {
    const normalized = relative.split(path.sep).join("/");
    if (isGitIgnored(normalized, ignoredByGit)) continue;
    if (!SUPPORTED_EXTENSIONS.has(path.extname(normalized).toLowerCase()))
      continue;
    if (path.isAbsolute(normalized) || normalized.split("/").includes("..")) {
      diagnostics.push({
        code: "DISCOVERY_UNSAFE_PATH",
        level: "error",
        message: `Skipped unsafe discovered path "${normalized}".`,
      });
      continue;
    }

    const absolute = path.resolve(root, normalized);
    if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
      diagnostics.push({
        code: "DISCOVERY_PATH_ESCAPE",
        level: "error",
        message: `Skipped a path outside the project root: "${normalized}".`,
      });
      continue;
    }
    try {
      const metadata = await stat(absolute);
      if (!metadata.isFile()) continue;
      if (metadata.size > config.settings.maxFileSizeKb * 1024) {
        diagnostics.push({
          code: "FILE_TOO_LARGE",
          level: "warning",
          message: `Skipped ${normalized}: file is larger than ${config.settings.maxFileSizeKb} KB.`,
          file: normalized,
        });
        continue;
      }
      files.push(normalized);
    } catch (error) {
      diagnostics.push({
        code: "FILE_UNREADABLE",
        level: "warning",
        message: `Skipped ${normalized}: ${error instanceof Error ? error.message : "cannot read file"}.`,
        file: normalized,
      });
    }
  }
  return { files, diagnostics };
}
