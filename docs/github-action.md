# GitHub Actions

Install ArchShield as a development dependency and commit the lockfile. Once the npm package is published, a repository can use the included workflow example or the composite action.

The example workflow:

- Runs on pull requests and pushes to `main`.
- Uses `contents: read` only.
- Runs `npm ci` and `npx --no-install archshield check`.
- Receives file/line workflow annotations from the CLI.

No personal access token or write permission is required for checks or annotations. The example assumes the application repo's `package.json` declares ArchShield and its lockfile is current.

`archshield check --format sarif --output archshield.sarif` creates a local SARIF report. To upload it to GitHub Code Scanning, add a separate upload step and grant `security-events: write` only to that workflow/job. ArchShield does not create inline pull-request comments.

Changed-file analysis requires the chosen base ref and enough Git history to compute the diff. Fetch the base branch in workflows that use `--changed-only --base origin/main`.
