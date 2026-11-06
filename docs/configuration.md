# Configuration

ArchShield reads `archshield.json` from the current working directory unless `--config` is provided. JSON is validated strictly: unknown fields, rule types, duplicate rule/layer IDs, malformed values, and references to undefined layers are rejected.

## Paths

`project.root` is resolved relative to the configuration file's directory. `include`, `exclude`, layer patterns, and rule patterns are interpreted relative to that project root. Importer and target paths in reports are project-relative, slash-normalized paths.

Patterns use picomatch glob syntax. Matching is case-sensitive by default; set `settings.caseSensitivePaths` to `false` for case-insensitive matching. The scanner also excludes `.git`, `node_modules`, `dist`, `coverage`, and `vendor` by default through the `exclude` defaults. Configured exclude patterns take precedence over include patterns.

Root and nested `.gitignore` files are applied to discovered source files. Symlink following is disabled unless `settings.followSymlinks` is enabled. `settings.maxFileSizeKb` limits source file size.

## Fields

| Field                                      | Meaning                                                                                         |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `version`                                  | Required configuration format version; currently `1`.                                           |
| `project.name`                             | Optional name used in reports.                                                                  |
| `project.root`                             | Project scan root, relative to the config file; defaults to `.`.                                |
| `include`                                  | Source glob patterns; defaults to supported JS/TS files under the root.                         |
| `exclude`                                  | Patterns removed from discovery.                                                                |
| `languages.typescript.enabled`             | Analyze `.ts` and `.tsx` files. Defaults to `true`.                                             |
| `languages.javascript.enabled`             | Analyze `.js`, `.jsx`, `.mjs`, and `.cjs` files. Defaults to `true`.                            |
| `languages.php.enabled` / `python.enabled` | Reserved adapters. Enabling either currently fails with an explicit unsupported-language error. |
| `layers`                                   | Named sets of source file patterns. A file should belong to at most one layer.                  |
| `rules`                                    | Ordered, uniquely identified architecture rules.                                                |
| `settings.unresolvedImports`               | `warn`, `error`, or `ignore` for unresolved local paths/aliases.                                |
| `settings.allowAmbiguousLayers`            | When true, the first declared matching layer wins; otherwise ambiguity is fatal.                |

See `archshield.example.json` for a complete configuration. The exact accepted structure is also published in `archshield.schema.json`.
