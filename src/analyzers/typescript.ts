import { readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { type ArchShieldConfig } from "../config/schema.js";
import { type Dependency, type Diagnostic } from "../model.js";
import { compareText } from "../core/sort.js";

export interface ExtractionResult {
  dependencies: Dependency[];
  diagnostics: Diagnostic[];
}

function asProjectRelative(root: string, target: string): string | null {
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  if (relative.split(path.sep).includes("node_modules")) return null;
  return relative.split(path.sep).join("/");
}

function isKnownPathAlias(
  specifier: string,
  paths: ts.MapLike<string[]> | undefined,
): boolean {
  if (!paths) return false;
  return Object.keys(paths).some((alias) => {
    const wildcardAt = alias.indexOf("*");
    if (wildcardAt === -1) return alias === specifier;
    const prefix = alias.slice(0, wildcardAt);
    const suffix = alias.slice(wildcardAt + 1);
    return specifier.startsWith(prefix) && specifier.endsWith(suffix);
  });
}

function getCompilerOptions(root: string): ts.CompilerOptions {
  const configPath = ts.findConfigFile(
    root,
    ts.sys.fileExists,
    "tsconfig.json",
  );
  if (!configPath) {
    return {
      allowJs: true,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      module: ts.ModuleKind.NodeNext,
      target: ts.ScriptTarget.ES2022,
    };
  }
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) {
    return {
      allowJs: true,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      module: ts.ModuleKind.NodeNext,
      target: ts.ScriptTarget.ES2022,
    };
  }
  return ts.parseJsonConfigFileContent(
    read.config,
    ts.sys,
    path.dirname(configPath),
  ).options;
}

export async function extractDependencies(
  root: string,
  files: string[],
  config: ArchShieldConfig,
): Promise<ExtractionResult> {
  const dependencies: Dependency[] = [];
  const diagnostics: Diagnostic[] = [];
  const compilerOptions = getCompilerOptions(root);
  const aliasPaths = compilerOptions.paths;
  const scriptKind = (file: string): ts.ScriptKind =>
    file.endsWith(".tsx")
      ? ts.ScriptKind.TSX
      : file.endsWith(".jsx")
        ? ts.ScriptKind.JSX
        : file.endsWith(".js") || file.endsWith(".mjs") || file.endsWith(".cjs")
          ? ts.ScriptKind.JS
          : ts.ScriptKind.TS;

  for (const relative of files) {
    const isTypeScript = [".ts", ".tsx"].includes(
      path.extname(relative).toLowerCase(),
    );
    const enabled = isTypeScript
      ? config.languages.typescript.enabled
      : config.languages.javascript.enabled;
    if (!enabled) continue;

    const absolute = path.resolve(root, relative);
    let contents: string;
    try {
      contents = await readFile(absolute, "utf8");
    } catch (error) {
      diagnostics.push({
        code: "SOURCE_UNREADABLE",
        level: "warning",
        message: `Could not read source: ${error instanceof Error ? error.message : "unknown error"}.`,
        file: relative,
      });
      continue;
    }

    const source = ts.createSourceFile(
      relative,
      contents,
      ts.ScriptTarget.Latest,
      true,
      scriptKind(relative),
    );
    const parseDiagnostics = (
      source as ts.SourceFile & {
        parseDiagnostics: readonly ts.Diagnostic[];
      }
    ).parseDiagnostics;
    for (const parseError of parseDiagnostics) {
      const position = parseError.start ?? 0;
      const location = source.getLineAndCharacterOfPosition(position);
      diagnostics.push({
        code: "SOURCE_PARSE",
        level: "warning",
        message: ts.flattenDiagnosticMessageText(parseError.messageText, " "),
        file: relative,
        line: location.line + 1,
        column: location.character + 1,
      });
    }

    const add = (
      specifier: string,
      node: ts.Node,
      kind: Dependency["kind"],
    ): void => {
      const position = source.getLineAndCharacterOfPosition(
        node.getStart(source),
      );
      const resolution = ts.resolveModuleName(
        specifier,
        absolute,
        compilerOptions,
        ts.sys,
      ).resolvedModule?.resolvedFileName;
      const resolvedTarget = resolution
        ? asProjectRelative(root, path.resolve(resolution))
        : null;
      const relativeSpecifier =
        specifier.startsWith(".") || path.isAbsolute(specifier);
      const localAlias = isKnownPathAlias(specifier, aliasPaths);
      const external =
        resolvedTarget === null && !relativeSpecifier && !localAlias;

      dependencies.push({
        importer: relative.split(path.sep).join("/"),
        specifier,
        resolvedTarget,
        line: position.line + 1,
        column: position.character + 1,
        kind,
        external,
      });

      if (
        (relativeSpecifier || localAlias) &&
        !resolvedTarget &&
        config.settings.unresolvedImports !== "ignore"
      ) {
        diagnostics.push({
          code: "IMPORT_UNRESOLVED",
          level:
            config.settings.unresolvedImports === "warn" ? "warning" : "error",
          message: `Cannot resolve local import "${specifier}". Check the path, extension, or tsconfig alias.`,
          file: relative,
          line: position.line + 1,
          column: position.character + 1,
        });
      }
    };

    const visit = (node: ts.Node): void => {
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        add(node.moduleSpecifier.text, node, "import");
      } else if (
        ts.isExportDeclaration(node) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        add(node.moduleSpecifier.text, node, "re-export");
      } else if (ts.isCallExpression(node) && node.arguments.length === 1) {
        const argument = node.arguments[0];
        if (!argument || !ts.isStringLiteral(argument)) {
          ts.forEachChild(node, visit);
          return;
        }
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          add(argument.text, node, "dynamic-import");
        } else if (
          ts.isIdentifier(node.expression) &&
          node.expression.text === "require"
        ) {
          add(argument.text, node, "require");
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  dependencies.sort(
    (a, b) =>
      compareText(a.importer, b.importer) ||
      a.line - b.line ||
      a.column - b.column ||
      compareText(a.specifier, b.specifier),
  );
  return { dependencies, diagnostics };
}
