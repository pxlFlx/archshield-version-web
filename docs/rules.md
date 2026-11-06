# Rules and matching

Rules use a unique lowercase `id`, a `severity` (`error`, `warning`, or `info`), and an optional custom `message`. All rules are evaluated; findings are deduplicated and sorted by severity, path, line, and rule ID.

## `layer-boundary`

Maps the importing file and resolved local target to configured layers. A finding is emitted when the source layer is listed in `from` and the target layer is listed in `to`. Files with no layer are not matched. Overlapping layer patterns are a fatal diagnostic unless `settings.allowAmbiguousLayers` is `true`; then the first declared matching layer is used.

```json
{
  "id": "no-ui-to-database",
  "type": "layer-boundary",
  "severity": "error",
  "from": ["presentation"],
  "to": ["infrastructure"]
}
```

## `forbidden-import`

`from` selects importer paths; `patterns` match dependency specifiers, resolved project-relative paths, or both. `match` defaults to `both`. Matching uses globs, not substring search.

```json
{
  "id": "no-private-modules",
  "type": "forbidden-import",
  "severity": "warning",
  "from": ["src/**"],
  "patterns": ["**/internal/**", "@legacy/**"],
  "match": "both"
}
```

## `allowed-dependency`

Restricts imports from matching importer files. `allowed` entries match target layer names, dependency specifiers, or resolved paths. `match` is `layer`, `path`, or `both` (default). An import not matching any allowed entry is reported.

## `no-cycles`

Builds a directed graph from resolved local imports and reports each distinct file-level cycle once. External and unresolved imports do not form graph edges.

## Exit behavior

Errors fail by default. Warnings and informational findings do not; `--fail-on-warn` also fails on new warnings. Baseline findings are non-blocking unless `--strict-baseline` is set. An unresolved local import is a diagnostic controlled by `settings.unresolvedImports`, not a rule finding.
