# Contributing

Thanks for contributing. Keep changes focused, add or update tests, and document user-visible behavior.

## Local checks

```sh
npm ci
npm run check
```

For CLI behavior, add integration coverage that runs the built command against a temporary project. Tests must not download dependencies or execute scanned source.

## Pull requests

- Explain the problem and expected behavior.
- Include a regression test for bug fixes.
- Keep supported-language claims aligned with tested adapters.
- Do not add secrets, repository data, generated output, or benchmark claims without reproducible evidence.
