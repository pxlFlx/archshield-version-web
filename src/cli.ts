#!/usr/bin/env node
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { Command, CommanderError } from "commander";
import { analyzeProject } from "./analyze.js";
import {
  BaselineError,
  markBaselineStatus,
  readBaseline,
  writeBaseline,
} from "./baseline/store.js";
import { ConfigError, loadConfig } from "./config/load.js";
import { formatGraph } from "./reporting/graph.js";
import {
  createReport,
  formatSarif,
  formatText,
  VERSION,
} from "./reporting/report.js";
import { type Finding, type Report } from "./model.js";
import { runUi } from "./ui-server.js";

const execFileAsync = promisify(execFile);
const DEFAULT_CONFIG = "archshield.json";
const DEFAULT_BASELINE = ".archshield-baseline.json";

const cleanArchitectureConfig = {
  version: 1,
  project: { name: "my-project", root: "." },
  include: ["src/**/*.{ts,tsx,js,jsx,mjs,cjs}"],
  exclude: [
    "**/*.test.*",
    "**/*.spec.*",
    "**/generated/**",
    "**/dist/**",
    "**/node_modules/**",
  ],
  languages: {
    typescript: { enabled: true },
    javascript: { enabled: true },
    php: { enabled: false },
    python: { enabled: false },
  },
  layers: [
    {
      name: "presentation",
      patterns: ["src/components/**", "src/views/**", "src/pages/**"],
    },
    { name: "application", patterns: ["src/services/**", "src/use-cases/**"] },
    { name: "domain", patterns: ["src/domain/**", "src/entities/**"] },
    {
      name: "infrastructure",
      patterns: [
        "src/repositories/**",
        "src/database/**",
        "src/infrastructure/**",
      ],
    },
  ],
  rules: [
    {
      id: "no-presentation-to-infrastructure",
      type: "layer-boundary",
      severity: "error",
      from: ["presentation"],
      to: ["infrastructure"],
      message: "Presentation code must not depend directly on infrastructure.",
    },
    {
      id: "no-domain-to-infrastructure",
      type: "layer-boundary",
      severity: "error",
      from: ["domain"],
      to: ["infrastructure"],
      message: "Domain code must not depend on infrastructure.",
    },
  ],
  settings: {
    maxFileSizeKb: 1000,
    followSymlinks: false,
    unresolvedImports: "warn",
    caseSensitivePaths: true,
    allowAmbiguousLayers: false,
  },
};

const reactConfig = {
  ...cleanArchitectureConfig,
  project: { name: "react-app", root: "." },
  layers: [
    {
      name: "presentation",
      patterns: ["src/components/**", "src/pages/**", "src/app/**"],
    },
    {
      name: "application",
      patterns: ["src/hooks/**", "src/services/**", "src/features/**"],
    },
    { name: "domain", patterns: ["src/domain/**", "src/models/**"] },
    {
      name: "infrastructure",
      patterns: ["src/api/**", "src/data/**", "src/database/**"],
    },
  ],
};

function createProgram(): Command {
  const program = new Command();
  program
    .name("archshield")
    .description("Local-first architectural dependency checks")
    .version(VERSION)
    .showHelpAfterError(false)
    .exitOverride();

  program
    .command("init")
    .description("Create a starter archshield.json")
    .option("-f, --force", "overwrite an existing configuration")
    .option("-p, --preset <name>", "starter preset", "clean-architecture")
    .option("-c, --config <path>", "configuration file path", DEFAULT_CONFIG)
    .action(
      async (options: { force?: boolean; preset: string; config: string }) => {
        await initializeConfig(options);
      },
    );

  program
    .command("check")
    .description("Analyze project dependencies against configured rules")
    .option("-c, --config <path>", "configuration file path", DEFAULT_CONFIG)
    .option("-f, --format <format>", "text, json, or sarif", "text")
    .option("-o, --output <path>", "write the report to a file")
    .option("--baseline <path>", "compare against a saved baseline")
    .option("--strict-baseline", "fail on existing baseline findings too")
    .option("--update-baseline", "write current findings to the baseline")
    .option("--changed-only", "show findings from changed source files only")
    .option("--base <ref>", "Git base revision used with --changed-only")
    .option("--verbose", "include detailed progress diagnostics")
    .option("--no-color", "disable ANSI color output")
    .option("--fail-on-warn", "treat new warnings as blocking")
    .action(async (options: CheckOptions) => {
      await runCheck(options);
    });

  program
    .command("graph")
    .description("Generate a dependency graph")
    .option("-c, --config <path>", "configuration file path", DEFAULT_CONFIG)
    .option("-f, --format <format>", "mermaid or dot", "mermaid")
    .option("-o, --output <path>", "write the graph to a file")
    .option("--include-external", "include external package nodes")
    .action(async (options: GraphOptions) => {
      await runGraph(options);
    });

  program
    .command("ui")
    .description("Open the local ArchShield browser interface")
    .option("-p, --port <port>", "local web server port", "4177")
    .option("--no-open", "do not open a browser automatically")
    .action(async (options: { port: string; open: boolean }) => {
      const port = Number(options.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error("Port must be a whole number between 1 and 65535.");
      }
      await runUi({
        port,
        open: options.open,
        initializeConfig: (projectRoot, preset) =>
          initializeConfig({
            preset,
            config: path.join(projectRoot, DEFAULT_CONFIG),
            quiet: true,
          }),
      });
    });

  return program;
}

interface CheckOptions {
  config: string;
  format: string;
  output?: string;
  baseline?: string;
  strictBaseline?: boolean;
  updateBaseline?: boolean;
  changedOnly?: boolean;
  base?: string;
  verbose?: boolean;
  color?: boolean;
  failOnWarn?: boolean;
}

interface GraphOptions {
  config: string;
  format: string;
  output?: string;
  includeExternal?: boolean;
}

export async function initializeConfig(options: {
  force?: boolean;
  preset: string;
  config: string;
  quiet?: boolean;
}): Promise<string> {
  if (options.preset !== "clean-architecture" && options.preset !== "react") {
    throw new Error(
      `Unknown preset "${options.preset}". Choose "clean-architecture" or "react".`,
    );
  }
  const destination = path.resolve(options.config);
  if (!options.force) {
    try {
      await access(destination);
      throw new Error(
        `Refusing to overwrite "${options.config}". Use --force to replace it.`,
      );
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Refusing"))
        throw error;
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code !== "ENOENT"
      ) {
        throw new Error(`Cannot access "${options.config}".`);
      }
    }
  }

  await mkdir(path.dirname(destination), { recursive: true });
  const selected =
    options.preset === "react" ? reactConfig : cleanArchitectureConfig;
  await writeFile(
    destination,
    `${JSON.stringify(selected, null, 2)}\n`,
    "utf8",
  );
  if (!options.quiet) {
    process.stdout.write(
      `Created ${path.relative(process.cwd(), destination) || path.basename(destination)}\n`,
    );
    process.stdout.write("Next: archshield check\n");
  }
  return destination;
}

async function changedSourceFiles(
  root: string,
  base: string,
): Promise<Set<string>> {
  if (
    !base ||
    base.startsWith("-") ||
    base.includes("\0") ||
    base.length > 200
  ) {
    throw new Error(
      "Invalid --base revision. Pass a local Git ref such as origin/main.",
    );
  }
  const git = async (args: string[]): Promise<string> => {
    try {
      const { stdout } = await execFileAsync("git", args, {
        cwd: root,
        maxBuffer: 5 * 1024 * 1024,
      });
      return stdout;
    } catch {
      throw new Error(
        `Cannot use Git base "${base}". Fetch the ref and ensure the checkout has enough history.`,
      );
    }
  };
  const revision = (
    await git([
      "rev-parse",
      "--verify",
      "--quiet",
      "--end-of-options",
      `${base}^{commit}`,
    ])
  ).trim();
  if (!revision)
    throw new Error(`Git base "${base}" did not resolve to a commit.`);
  const output = await git([
    "diff",
    "--name-only",
    "--diff-filter=ACMRT",
    `${revision}...HEAD`,
    "--",
  ]);
  return new Set(
    output
      .split(/\r?\n/)
      .filter(Boolean)
      .map((file) => file.split(path.sep).join("/")),
  );
}

function filterChanged(findings: Finding[], changed: Set<string>): Finding[] {
  return findings.filter((finding) => changed.has(finding.importer));
}

function emitGitHubAnnotations(report: Report): void {
  if (process.env.GITHUB_ACTIONS !== "true") return;
  for (const finding of report.findings) {
    const command =
      finding.severity === "error"
        ? "error"
        : finding.severity === "warning"
          ? "warning"
          : "notice";
    const escape = (value: string): string =>
      value
        .replaceAll("%", "%25")
        .replaceAll("\r", "%0D")
        .replaceAll("\n", "%0A")
        .replaceAll(":", "%3A")
        .replaceAll(",", "%2C");
    process.stderr.write(
      `::${command} file=${escape(finding.importer)},line=${finding.line},col=${finding.column},title=${escape(finding.ruleId)}::${escape(finding.message)}\n`,
    );
  }
}

function shouldFail(report: Report, options: CheckOptions): boolean {
  if (
    report.diagnostics.some(
      (diagnostic) => diagnostic.code === "ANALYSIS_FATAL",
    )
  )
    return true;
  if (
    report.diagnostics.some(
      (diagnostic) => diagnostic.code === "DISCOVERY_PATH_ESCAPE",
    )
  )
    return true;
  const blocking = report.findings.filter(
    (finding) =>
      finding.baselineStatus !== "existing" || options.strictBaseline,
  );
  return blocking.some(
    (finding) =>
      finding.severity === "error" ||
      (options.failOnWarn === true && finding.severity === "warning"),
  );
}

async function writeOutput(
  destination: string | undefined,
  contents: string,
): Promise<void> {
  if (!destination) {
    process.stdout.write(
      `${contents.endsWith("\n") ? contents : `${contents}\n`}`,
    );
    return;
  }
  const absolute = path.resolve(destination);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(
    absolute,
    `${contents.endsWith("\n") ? contents : `${contents}\n`}`,
    "utf8",
  );
}

async function runCheck(options: CheckOptions): Promise<void> {
  if (!["text", "json", "sarif"].includes(options.format)) {
    throw new Error(
      `Unknown report format "${options.format}". Choose text, json, or sarif.`,
    );
  }
  if (options.changedOnly && !options.base) {
    throw new Error("--changed-only requires --base <ref>.");
  }

  const start = performance.now();
  const loaded = await loadConfig(options.config);
  const analysis = await analyzeProject(loaded);
  let findings = analysis.findings;
  const baselinePath = options.baseline
    ? path.resolve(options.baseline)
    : options.updateBaseline
      ? path.resolve(DEFAULT_BASELINE)
      : undefined;
  let baseline = new Set<string>();

  if (options.updateBaseline && baselinePath) {
    await writeBaseline(baselinePath, findings);
    baseline = new Set(findings.map((finding) => finding.fingerprint));
  } else if (baselinePath) {
    baseline = await readBaseline(baselinePath);
  }
  findings = markBaselineStatus(findings, baseline);

  if (options.changedOnly && options.base) {
    const changed = await changedSourceFiles(loaded.projectRoot, options.base);
    findings = filterChanged(findings, changed);
    if (options.verbose) {
      process.stderr.write(`Changed source files: ${changed.size}\n`);
    }
  }

  const duration = performance.now() - start;
  const projectName =
    loaded.config.project.name ?? path.basename(loaded.projectRoot);
  const report = createReport(projectName, analysis, findings, duration);
  emitGitHubAnnotations(report);

  const color =
    options.color === true &&
    process.stdout.isTTY === true &&
    process.env.NO_COLOR === undefined &&
    options.format === "text";
  const output =
    options.format === "json"
      ? JSON.stringify(report, null, 2)
      : options.format === "sarif"
        ? formatSarif(report)
        : formatText(report, color);
  await writeOutput(options.output, output);

  if (options.updateBaseline && baselinePath && options.format === "text") {
    process.stdout.write(
      `Baseline updated: ${path.relative(process.cwd(), baselinePath)}. Review entries; updating can hide new issues.\n`,
    );
  }
  if (shouldFail(report, options)) process.exitCode = 1;
}

async function runGraph(options: GraphOptions): Promise<void> {
  if (options.format !== "mermaid" && options.format !== "dot") {
    throw new Error(
      `Unknown graph format "${options.format}". Choose mermaid or dot.`,
    );
  }
  const loaded = await loadConfig(options.config);
  const analysis = await analyzeProject(loaded);
  if (
    analysis.diagnostics.some(
      (diagnostic) => diagnostic.code === "ANALYSIS_FATAL",
    )
  ) {
    throw new Error(
      analysis.diagnostics.find(
        (diagnostic) => diagnostic.code === "ANALYSIS_FATAL",
      )?.message ?? "Analysis failed.",
    );
  }
  const graph = formatGraph(
    analysis.dependencies,
    options.format,
    options.includeExternal === true,
  );
  await writeOutput(options.output, graph);
}

export async function runCli(argv: string[] = process.argv): Promise<void> {
  const program = createProgram();
  try {
    await program.parseAsync(argv);
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.exitCode !== 0) process.exitCode = 2;
      return;
    }
    const message =
      error instanceof ConfigError || error instanceof BaselineError
        ? error.message
        : error instanceof Error
          ? error.message
          : "An unexpected error occurred.";
    process.stderr.write(`ArchShield: ${message}\n`);
    process.exitCode = 2;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  void runCli();
}
