# Architecture

ArchShield keeps analysis local and separates source parsing from policy evaluation:

1. **Configuration** validates version 1 and rejects unknown or inconsistent rules before scanning.
2. **Discovery** expands include/exclude patterns, applies `.gitignore`, rejects unsafe paths, and enforces file-size limits.
3. **Language adapter** parses TypeScript/JavaScript with the TypeScript Compiler API without executing source. It extracts static imports, re-exports, literal dynamic imports, and literal `require()` calls.
4. **Resolution** delegates module resolution to TypeScript and project `tsconfig.json` settings. Resolved targets inside `node_modules` are treated as external; local unresolved paths are diagnostics.
5. **Rule engine** evaluates normalized dependency records, computes stable fingerprints, and sorts findings.
6. **Reporters** format text, JSON, SARIF, Mermaid, and DOT output. The GitHub Actions environment receives workflow annotations without requiring write permissions.

The project has no server, database, user account, or hosted service dependency. PHP/Python adapters, inline suppressions, PR review comments, and HTML reports are out of scope for this release.
