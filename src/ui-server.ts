import { spawn } from "node:child_process";
import { access, readFile, readdir, stat } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeProject } from "./analyze.js";
import { ConfigError, loadConfig } from "./config/load.js";
import { createReport, VERSION } from "./reporting/report.js";

const uiDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "local-ui",
);
const maxRequestBytes = 16 * 1024;
const maxListedDirectories = 250;

interface UiServerOptions {
  port: number;
  open?: boolean;
  initializeConfig: (projectRoot: string, preset: UiPreset) => Promise<string>;
}

type UiPreset = "clean-architecture" | "react";

interface JsonRequest {
  projectPath?: unknown;
  preset?: unknown;
}

export async function runUi({
  port,
  open = true,
  initializeConfig,
}: UiServerOptions): Promise<void> {
  const server = createServer((request, response) => {
    void handleRequest(request, response, port, initializeConfig).catch(
      (error: unknown) => {
        sendJson(
          response,
          error instanceof UiRequestError ? error.statusCode : 500,
          { error: error instanceof Error ? error.message : "Request failed." },
        );
      },
    );
  });
  server.requestTimeout = 30_000;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = `http://127.0.0.1:${port}`;
  process.stdout.write(`ArchShield is running at ${address}\n`);
  process.stdout.write("Press Ctrl+C to stop the local interface.\n");
  if (open) openBrowser(address);
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  port: number,
  initializeConfig?: UiServerOptions["initializeConfig"],
): Promise<void> {
  setSecurityHeaders(response);
  if (!isLocalRequest(request, port)) {
    sendJson(response, 403, {
      error: "ArchShield only accepts local requests.",
    });
    return;
  }

  const requestUrl = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
  if (requestUrl.pathname === "/api/status" && request.method === "GET") {
    const projectRoot = process.cwd();
    const configExists = await access(path.join(projectRoot, "archshield.json"))
      .then(() => true)
      .catch(() => false);
    sendJson(response, 200, {
      projectRoot,
      version: VERSION,
      configExists,
      localOnly: true,
    });
    return;
  }

  if (requestUrl.pathname === "/api/browse" && request.method === "GET") {
    const requestedPath = requestUrl.searchParams.get("path") ?? process.cwd();
    const currentPath = await resolveProjectRoot(requestedPath);
    let entries;
    try {
      entries = await readdir(currentPath, { withFileTypes: true });
    } catch {
      throw new UiRequestError(400, "This folder cannot be opened.");
    }
    const directories = entries
      .filter(
        (entry) =>
          entry.isDirectory() &&
          entry.name !== "node_modules" &&
          entry.name !== ".git",
      )
      .map((entry) => ({
        name: entry.name,
        path: path.join(currentPath, entry.name),
      }))
      .sort((first, second) => first.name.localeCompare(second.name));
    sendJson(response, 200, {
      currentPath,
      parentPath:
        path.dirname(currentPath) === currentPath
          ? null
          : path.dirname(currentPath),
      directories: directories.slice(0, maxListedDirectories),
      truncated: directories.length > maxListedDirectories,
    });
    return;
  }

  if (requestUrl.pathname === "/api/scan" && request.method === "POST") {
    const body = await readJson(request);
    const projectRoot = await resolveProjectRoot(body.projectPath);
    let loaded: Awaited<ReturnType<typeof loadConfig>>;
    try {
      loaded = await loadConfig(path.join(projectRoot, "archshield.json"));
    } catch (error) {
      if (error instanceof ConfigError) {
        throw new UiRequestError(422, error.message);
      }
      throw error;
    }
    const startedAt = Date.now();
    const analysis = await analyzeProject(loaded);
    const fatal = analysis.diagnostics.find(
      (diagnostic) => diagnostic.code === "ANALYSIS_FATAL",
    );
    if (fatal) {
      sendJson(response, 422, { error: fatal.message });
      return;
    }
    const report = createReport(
      loaded.config.project.name ?? path.basename(projectRoot),
      analysis,
      analysis.findings,
      Date.now() - startedAt,
    );
    sendJson(response, 200, report);
    return;
  }

  if (requestUrl.pathname === "/api/init" && request.method === "POST") {
    const body = await readJson(request);
    const projectRoot = await resolveProjectRoot(body.projectPath);
    const preset = body.preset;
    if (preset !== "clean-architecture" && preset !== "react") {
      throw new UiRequestError(
        400,
        'Choose the "clean-architecture" or "react" preset.',
      );
    }
    if (!initializeConfig) {
      throw new UiRequestError(500, "Config setup is unavailable.");
    }
    let configPath: string;
    try {
      configPath = await initializeConfig(projectRoot, preset);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("Refusing to overwrite")
      ) {
        throw new UiRequestError(409, error.message);
      }
      throw error;
    }
    sendJson(response, 201, {
      configPath: path.relative(projectRoot, configPath),
      preset,
    });
    return;
  }

  if (requestUrl.pathname.startsWith("/api/")) {
    sendJson(response, 404, { error: "ArchShield endpoint not found." });
    return;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    sendJson(response, 405, { error: "Method not allowed." });
    return;
  }
  await serveStatic(requestUrl.pathname, request.method === "HEAD", response);
}

function isLocalRequest(request: IncomingMessage, port: number): boolean {
  const host = request.headers.host?.toLowerCase();
  const allowedHosts = new Set([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `[::1]:${port}`,
  ]);
  if (!host || !allowedHosts.has(host)) return false;

  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const originUrl = new URL(origin);
    return (
      originUrl.protocol === "http:" &&
      allowedHosts.has(originUrl.host.toLowerCase())
    );
  } catch {
    return false;
  }
}

async function resolveProjectRoot(value: unknown): Promise<string> {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new UiRequestError(400, "Choose a project folder before continuing.");
  }
  if (value.length > 4096 || value.includes("\0")) {
    throw new UiRequestError(400, "The project folder path is invalid.");
  }
  const projectRoot = path.resolve(value);
  const details = await stat(projectRoot).catch(() => null);
  if (!details?.isDirectory()) {
    throw new UiRequestError(
      400,
      `Project folder does not exist: ${projectRoot}`,
    );
  }
  return projectRoot;
}

async function readJson(request: IncomingMessage): Promise<JsonRequest> {
  const contentType = request.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new UiRequestError(415, "Send request data as JSON.");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxRequestBytes) {
      throw new UiRequestError(413, "Request is too large.");
    }
    chunks.push(buffer);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new UiRequestError(400, "Request data must be a JSON object.");
    }
    return value as JsonRequest;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new UiRequestError(400, "Request JSON is invalid.");
    }
    throw error;
  }
}

async function serveStatic(
  pathname: string,
  headOnly: boolean,
  response: ServerResponse,
): Promise<void> {
  let requestedPath: string;
  try {
    requestedPath = decodeURIComponent(pathname);
  } catch {
    sendJson(response, 400, { error: "Invalid URL path." });
    return;
  }

  const relativePath =
    requestedPath === "/" ? "index.html" : requestedPath.replace(/^\/+/, "");
  const resolvedPath = path.resolve(uiDirectory, relativePath);
  if (
    resolvedPath !== uiDirectory &&
    !resolvedPath.startsWith(`${uiDirectory}${path.sep}`)
  ) {
    sendJson(response, 404, { error: "File not found." });
    return;
  }

  let contents: Buffer;
  let actualPath = resolvedPath;
  try {
    const details = await stat(resolvedPath);
    actualPath = details.isDirectory()
      ? path.join(resolvedPath, "index.html")
      : resolvedPath;
    contents = await readFile(actualPath);
  } catch {
    if (path.extname(requestedPath)) {
      sendJson(response, 404, { error: "File not found." });
      return;
    }
    actualPath = path.join(uiDirectory, "index.html");
    try {
      contents = await readFile(actualPath);
    } catch {
      sendJson(response, 503, {
        error:
          "The ArchShield web files are missing. Rebuild or reinstall ArchShield.",
      });
      return;
    }
  }

  response.statusCode = 200;
  response.setHeader("Content-Type", contentTypeFor(actualPath));
  response.setHeader("Content-Length", contents.length);
  response.end(headOnly ? undefined : contents);
}

function contentTypeFor(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cache-Control", "no-store");
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  value: unknown,
): void {
  const body = Buffer.from(JSON.stringify(value));
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", body.length);
  response.end(body);
}

class UiRequestError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "UiRequestError";
  }
}

function openBrowser(address: string): void {
  const [command, args] =
    process.platform === "win32"
      ? ["cmd.exe", ["/c", "start", "", address]]
      : process.platform === "darwin"
        ? ["open", [address]]
        : ["xdg-open", [address]];
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.once("error", () => {
    process.stdout.write(`Open this address in your browser: ${address}\n`);
  });
  child.unref();
}
