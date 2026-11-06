# Troubleshooting

## Config is rejected

Check that `version` is `1`, rule types are supported, IDs are unique, all layer names are declared, and there are no unknown properties. Run `archshield init` in an empty folder to create a valid starter.

## Local import is unresolved

Check the relative path, file extension, `index` file, and `tsconfig.json` path aliases. ArchShield does not install dependencies. Set `settings.unresolvedImports` to `ignore` only when unresolved-local-import messages are not useful for the project.

## File matches multiple layers

Make layer patterns disjoint. If overlaps are intentional, set `settings.allowAmbiguousLayers` to `true`; the first declared layer wins.

## PHP or Python is enabled

Those parsers are planned and are not implemented. Disable the language flag; the tool will not silently scan either language with fragile text matching.

## `--changed-only` cannot find the base

Fetch the base branch and enough commit history. Use a local ref such as `origin/main`; ArchShield does not download refs automatically. The option requires `--base`.

## A file is missing from analysis

Check `include`, `exclude`, `.gitignore`, supported file extensions, symlink policy, and `maxFileSizeKb`. Oversized and unreadable files are reported as diagnostics.
