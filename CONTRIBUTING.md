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

- **TypeScript strict mode** — `strict: true`, no `any`, no type assertions unless absolutely necessary.
- **ESM only** — `"type": "module"`, imports with `.js` extension.
- **Pure functions** — Every exported function should be deterministic and side-effect free (normalizers are the documented exception — they mutate a copy, not the original).
- **One dependency** — The core package depends on Zod only. Do not add dependencies without discussion.
- **Tests required** — Every PR must include tests. Every bug fix must include a regression test.

## Pull requests

1. Fork the repo and create a branch from `main`.
2. Write your changes with tests.
3. Run `npm test` and `npm run typecheck` — both must pass.
4. Open a PR with a clear description of what changed and why.

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
