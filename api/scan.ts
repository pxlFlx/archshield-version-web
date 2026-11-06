import { createReport } from "../dist/reporting/report.js";
import { analyzeProject } from "../dist/analyze.js";
import { ConfigError, loadConfig } from "../dist/config/load.js";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import type { IncomingMessage, ServerResponse } from "node:http";

export const config = { api: { bodyParser: false } };

const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const MAX_GITHUB_ARCHIVE_BYTES = 8 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 24 * 1024 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 1_500;
const MAX_ENTRIES = 2_000;
const MAX_GITHUB_WAIT_MS = 15_000;

const DEFAULT_CONFIG = {
  version: 1,
  project: { root: "." },
  include: ["**/*.{ts,tsx,js,jsx,mjs,cjs}"],
  exclude: [
    "**/node_modules/**", "**/.git/**", "**/dist/**", "**/build/**",
    "**/coverage/**", "**/.next/**", "**/vendor/**", "**/*.test.*", "**/*.spec.*",
  ],
  languages: {
    typescript: { enabled: true }, javascript: { enabled: true },
    php: { enabled: false }, python: { enabled: false },
  },
  layers: [
    { name: "presentation", patterns: ["src/components/**", "src/pages/**", "src/views/**", "src/presentation/**", "app/**", "pages/**"] },
    { name: "application", patterns: ["src/services/**", "src/use-cases/**", "src/application/**"] },
    { name: "domain", patterns: ["src/domain/**", "src/entities/**", "src/core/**"] },
    { name: "infrastructure", patterns: ["src/repositories/**", "src/database/**", "src/infrastructure/**", "src/adapters/**"] },
  ],
  rules: [
    { id: "no-presentation-to-infrastructure", type: "layer-boundary", severity: "error", from: ["presentation"], to: ["infrastructure"], message: "Presentation code should not depend directly on infrastructure." },
    { id: "no-domain-to-infrastructure", type: "layer-boundary", severity: "error", from: ["domain"], to: ["infrastructure"], message: "Domain code should not depend directly on infrastructure." },
    { id: "no-private-imports", type: "forbidden-import", severity: "warning", from: ["src/**/*", "app/**/*", "pages/**/*"], patterns: ["**/internal/**", "**/private/**"], match: "path" },
    { id: "no-circular-dependencies", type: "no-cycles", severity: "warning" },
  ],
  settings: { maxFileSizeKb: 1000, followSymlinks: false, unresolvedImports: "warn", caseSensitivePaths: true, allowAmbiguousLayers: false },
};

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  applyHeaders(res);
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return sendJson(res, 405, { error: "Use POST to submit a GitHub repository or ZIP archive." });
  }

  const origin = req.headers.origin;
  const host = req.headers["x-forwarded-host"] ?? req.headers.host;
  if (origin && typeof host === "string") {
    try {
      const originUrl = new URL(origin);
      if (originUrl.host.toLowerCase() !== host.toLowerCase()) {
        return sendJson(res, 403, { error: "Cross-origin requests are not allowed." });
      }
    } catch {
      return sendJson(res, 403, { error: "Invalid request origin." });
    }
  }

  let workDir: string | undefined;
  try {
    const contentType = String(req.headers["content-type"] ?? "").toLowerCase();
    let archive: Buffer;
    let sourceLabel: string;

    if (contentType.includes("application/zip") || contentType.includes("application/octet-stream")) {
      archive = await readRequest(req, MAX_UPLOAD_BYTES);
      if (archive.length < 22) throw new HttpError(400, "The uploaded file is not a valid ZIP archive.");
      sourceLabel = "Uploaded ZIP archive";
    } else if (contentType.includes("application/json")) {
      let payload: { repository?: unknown };
      try { payload = JSON.parse((await readRequest(req, 8 * 1024)).toString("utf8")) as { repository?: unknown }; }
      catch { throw new HttpError(400, "Request body must be valid JSON."); }
      if (typeof payload.repository !== "string") throw new HttpError(400, "Provide a public GitHub repository URL.");
      const repository = parseGitHubRepository(payload.repository);
      archive = await downloadGitHubArchive(repository.owner, repository.repo);
      sourceLabel = `${repository.owner}/${repository.repo}`;
    } else {
      throw new HttpError(415, "Send a ZIP file or JSON containing a public GitHub repository URL.");
    }

    workDir = await mkdtemp(path.join(tmpdir(), "archshield-"));
    const projectRoot = await extractProjectZip(archive, workDir);
    const configPath = path.join(projectRoot, "archshield.json");
    const hasConfig = await readFile(configPath, "utf8").then(() => true).catch(() => false);
    if (!hasConfig) await writeFile(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2), { flag: "wx" });

    const loaded = await loadConfig(configPath);
    const relativeRoot = path.relative(projectRoot, loaded.projectRoot);
    if (relativeRoot.startsWith("..") || path.isAbsolute(relativeRoot)) {
      throw new HttpError(422, "The project.root setting in archshield.json must stay inside the uploaded repository.");
    }

    const startedAt = Date.now();
    const analysis = await analyzeProject(loaded);
    if (analysis.diagnostics.some((diagnostic) => diagnostic.code === "ANALYSIS_FATAL")) {
      throw new HttpError(422, "ArchShield could not complete the analysis. Check the repository configuration and source files.");
    }
    const report = createReport(
      loaded.config.project.name ?? sourceLabel,
      analysis,
      analysis.findings,
      Date.now() - startedAt,
    );
    return sendJson(res, 200, {
      ...report,
      source: sourceLabel,
      configuration: hasConfig ? "repository" : "automatic-defaults",
      notice: hasConfig ? null : "No archshield.json was found. A conservative default ruleset was used; add your own configuration for project-specific architecture policies.",
    });
  } catch (error) {
    const status = error instanceof HttpError ? error.statusCode : error instanceof ConfigError ? 422 : 500;
    const message = error instanceof Error ? error.message : "Analysis failed. Please try again.";
    return sendJson(res, status, { error: message });
  } finally {
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function parseGitHubRepository(input: string): { owner: string; repo: string } {
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw new HttpError(400, "Enter a valid GitHub repository URL, such as https://github.com/owner/repository."); }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com" || url.username || url.password || url.port || url.search || url.hash) {
    throw new HttpError(400, "Only public repositories hosted at https://github.com/owner/repository are supported.");
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 2 || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(parts[0]!) || !/^[A-Za-z0-9._-]{1,100}$/.test(parts[1]!)) {
    throw new HttpError(400, "Use a repository URL in the format https://github.com/owner/repository.");
  }
  return { owner: parts[0]!, repo: parts[1]!.replace(/\.git$/i, "") };
}

async function downloadGitHubArchive(owner: string, repo: string): Promise<Buffer> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MAX_GITHUB_WAIT_MS);
  try {
    const response = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/zipball`, {
      headers: { "Accept": "application/vnd.github+json", "User-Agent": "ArchShield-Online-Scanner", "X-GitHub-Api-Version": "2022-11-28" },
      redirect: "follow", signal: controller.signal,
    });
    if (!response.ok) {
      if (response.status === 404) throw new HttpError(404, "Repository not found, private, or unavailable. Only public GitHub repositories can be scanned.");
      if (response.status === 429) throw new HttpError(429, "GitHub rate limit reached. Wait a little and try again.");
      throw new HttpError(502, `GitHub could not provide this repository archive (HTTP ${response.status}).`);
    }
    const finalUrl = new URL(response.url);
    if (finalUrl.protocol !== "https:" || !["codeload.github.com", "github.com"].includes(finalUrl.hostname)) {
      throw new HttpError(502, "GitHub returned an unexpected archive location.");
    }
    return await readWebBody(response, MAX_GITHUB_ARCHIVE_BYTES);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (controller.signal.aborted) throw new HttpError(504, "GitHub took too long to provide the archive. Try a smaller repository.");
    throw new HttpError(502, "Could not download the public GitHub repository. Check the URL and try again.");
  } finally { clearTimeout(timeout); }
}

async function readRequest(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []; let total = 0;
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += part.length;
    if (total > limit) throw new HttpError(413, `Request exceeds the ${Math.floor(limit / 1024 / 1024)} MB limit.`);
    chunks.push(part);
  }
  return Buffer.concat(chunks);
}

async function readWebBody(response: Response, limit: number): Promise<Buffer> {
  if (!response.body) throw new HttpError(502, "GitHub returned an empty archive.");
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      total += value.length;
      if (total > limit) { await reader.cancel(); throw new HttpError(413, "The GitHub repository archive is too large for the free online scanner. Try a smaller repository or upload a filtered ZIP."); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

async function extractProjectZip(archive: Buffer, destination: string): Promise<string> {
  const entries = readZipEntries(archive);
  const files = entries.filter((entry) => !entry.name.endsWith("/") && isRelevantFile(entry.name));
  if (files.length === 0) throw new HttpError(422, "No TypeScript or JavaScript source files were found in this archive.");
  if (files.length > MAX_FILES) throw new HttpError(413, `The archive contains more than ${MAX_FILES} relevant files.`);

  const names = files.map((entry) => entry.name.split("/").filter(Boolean));
  const first = names[0]?.[0];
  const commonRoot = Boolean(first && names.every((parts) => parts.length >= 2 && parts[0] === first));
  const ordinaryRoots = new Set(["src", "app", "pages", "tests", "lib", "public", "ui", "components", "packages", "scripts", "examples"]);
  const stripRoot = commonRoot && !ordinaryRoots.has(first!.toLowerCase());
  let totalUncompressed = 0;
  for (const entry of files) {
    const parts = entry.name.split("/").filter(Boolean);
    const relativeParts = stripRoot ? parts.slice(1) : parts;
    if (relativeParts.length === 0) continue;
    const relative = relativeParts.join("/");
    const target = path.resolve(destination, relative);
    if (target !== destination && !target.startsWith(`${destination}${path.sep}`)) throw new HttpError(400, "The ZIP contains an unsafe file path.");
    const contents = extractZipEntry(archive, entry);
    totalUncompressed += contents.length;
    if (totalUncompressed > MAX_UNCOMPRESSED_BYTES) throw new HttpError(413, "The expanded archive exceeds the 24 MB safety limit.");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents, { flag: "wx" });
  }
  return destination;
}

interface ZipEntry { name: string; method: number; flags: number; crc32: number; compressedSize: number; uncompressedSize: number; localOffset: number; externalAttributes: number; }
function readZipEntries(zip: Buffer): ZipEntry[] {
  const min = Math.max(0, zip.length - 65_557); let eocd = -1;
  for (let i = zip.length - 22; i >= min; i--) if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new HttpError(400, "Invalid ZIP: end-of-directory record was not found.");
  const count = zip.readUInt16LE(eocd + 10); const centralSize = zip.readUInt32LE(eocd + 12); const centralOffset = zip.readUInt32LE(eocd + 16);
  if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw new HttpError(400, "ZIP64 archives are not supported. Create a standard ZIP archive.");
  if (count > MAX_ENTRIES || centralOffset + centralSize > eocd) throw new HttpError(413, "The ZIP archive has too many entries or an invalid directory.");
  const entries: ZipEntry[] = []; let offset = centralOffset;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > zip.length || zip.readUInt32LE(offset) !== 0x02014b50) throw new HttpError(400, "Invalid ZIP central directory.");
    const madeBy = zip.readUInt16LE(offset + 4); const flags = zip.readUInt16LE(offset + 8); const method = zip.readUInt16LE(offset + 10);
    const crc32Value = zip.readUInt32LE(offset + 16); const compressedSize = zip.readUInt32LE(offset + 20); const uncompressedSize = zip.readUInt32LE(offset + 24);
    const nameLength = zip.readUInt16LE(offset + 28); const extraLength = zip.readUInt16LE(offset + 30); const commentLength = zip.readUInt16LE(offset + 32);
    const externalAttributes = zip.readUInt32LE(offset + 38); const localOffset = zip.readUInt32LE(offset + 42);
    const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString(flags & 0x800 ? "utf8" : "utf8");
    if (flags & 1) throw new HttpError(400, "Encrypted ZIP entries are not supported.");
    if (method !== 0 && method !== 8) throw new HttpError(400, "ZIP must use Store or Deflate compression.");
    if (uncompressedSize > MAX_FILE_BYTES) throw new HttpError(413, `Archive entry exceeds the ${MAX_FILE_BYTES / 1024 / 1024} MB per-file limit.`);
    const unixMode = madeBy >> 8 === 3 ? externalAttributes >>> 16 : 0;
    if ((unixMode & 0xf000) === 0xa000) throw new HttpError(400, "Symbolic links are not accepted in uploaded archives.");
    if (name.includes("\\") || name.includes("\0") || name.startsWith("/") || /^[A-Za-z]:/.test(name) || name.split("/").includes("..")) throw new HttpError(400, "The ZIP contains an unsafe file path.");
    entries.push({ name, method, flags, crc32: crc32Value, compressedSize, uncompressedSize, localOffset, externalAttributes });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function extractZipEntry(zip: Buffer, entry: ZipEntry): Buffer {
  const offset = entry.localOffset;
  if (offset + 30 > zip.length || zip.readUInt32LE(offset) !== 0x04034b50) throw new HttpError(400, "Invalid ZIP local file header.");
  const nameLength = zip.readUInt16LE(offset + 26); const extraLength = zip.readUInt16LE(offset + 28);
  const start = offset + 30 + nameLength + extraLength; const end = start + entry.compressedSize;
  if (end > zip.length) throw new HttpError(400, "ZIP entry data is truncated.");
  const compressed = zip.subarray(start, end);
  let output: Buffer;
  try { output = entry.method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: MAX_FILE_BYTES }); }
  catch { throw new HttpError(400, "A ZIP entry could not be safely decompressed."); }
  if (output.length !== entry.uncompressedSize) throw new HttpError(400, "ZIP entry size does not match its directory record.");
  if (calculateCrc32(output) !== entry.crc32) throw new HttpError(400, "ZIP entry failed its integrity check.");
  return output;
}

const CRC32_TABLE = new Uint32Array(256);
for (let index = 0; index < CRC32_TABLE.length; index++) {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  CRC32_TABLE[index] = value >>> 0;
}

function calculateCrc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = (CRC32_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function isRelevantFile(name: string): boolean {
  const normalized = name.toLowerCase();
  if (normalized.split("/").some((part) => [".git", "node_modules", "vendor", "dist", "build", "coverage", ".next"].includes(part))) return false;
  return /\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(normalized) || /(^|\/)(?:archshield\.json|tsconfig(?:\.[^/]*)?\.json|\.gitignore|package\.json)$/.test(normalized);
}

function applyHeaders(res: ServerResponse): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
}
function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value));
  res.statusCode = status; res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", body.length); res.end(body);
}
class HttpError extends Error { constructor(readonly statusCode: number, message: string) { super(message); } }
