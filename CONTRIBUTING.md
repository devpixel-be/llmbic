# Contributing to Llmbic

Thanks for your interest in contributing to Llmbic.

## Development setup

```bash
git clone <repo-url>
cd llmbic
npm install
npm test
```

## Guidelines

- **TypeScript strict mode** - `strict: true`, no `any`, no type assertions unless absolutely necessary.
- **ESM only** - `"type": "module"`, imports with `.js` extension.
- **Pure functions** - Every exported function should be deterministic and side-effect free (normalizers are the documented exception - they mutate a copy, not the original).
- **One dependency** - The core package depends on Zod only. Do not add dependencies without discussion.
- **Tests required** - Every PR must include tests. Every bug fix must include a regression test.

## Pull requests

1. Fork the repo and create a branch from `main`.
2. Write your changes with tests.
3. Run `npm test` and `npm run typecheck` - both must pass.
4. Open a PR with a clear description of what changed and why.

## Releasing a new version

Publishing llmbic to npm is a five-step process. Skipping any step leaves the package in an inconsistent state (version on npm diverging from source, undocumented features, stale CHANGELOG). No shortcuts.

1. **Tests and typecheck** - every change must ship with tests. Regression tests are mandatory for bug fixes. `npm run typecheck` and `npm test` must both pass before starting the release.
2. **Version bump** - edit `package.json`. Follow SemVer strictly: major for breaking changes, minor for additive features, patch for fixes. Update `CHANGELOG.md` with a dated section for the new version listing additions, fixes, and breaking changes separately.
3. **Documentation** - if the public API changed, update `README.md` (signatures, feature tables, examples). Every exported signature in the "API reference" section must match the code.
4. **Tag** - commit the version bump, CHANGELOG and docs in a dedicated `chore(release): vX.Y.Z` commit. Create an annotated git tag `vX.Y.Z` on that commit and push both.
5. **Publish** - `npm publish`. The `prepublishOnly` hook re-runs `typecheck`, `test`, and `build`; do not skip or work around it.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add support for array fields in rules
fix: handle null values in confidence comparison
docs: add example for custom LLM provider
test: add regression test for string comparison edge case
```

## Reporting bugs

Open an issue with:
- A minimal reproduction (schema + rules + content + expected vs actual result)
- Llmbic version
- Node.js version

## Code of conduct

Be kind, be constructive, be respectful. We're all here to build something useful.
