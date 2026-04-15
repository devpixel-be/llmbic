# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-04-15

Initial public release.

### Added

- `createExtractor(config)` — factory binding a Zod schema, deterministic rules and an optional LLM fallback into an extractor with `extract`, `extractSync`, `prompt`, `parse` and `merge` methods. Covers both one-shot async extraction and 4-step batch flows (extractSync → prompt → external LLM call → parse → merge).
- `rule` namespace — `rule.create(field, extractFn)`, `rule.regex(field, pattern, score, transform?)`, `rule.confidence(value, score)`, `rule.apply(content, rules, schema, logger?)`. Deterministic rules are pure synchronous functions returning typed matches with a confidence score in `[0, 1]`.
- `merge` namespace — `merge.apply(schema, rulesResult, llmResult, content, options?)` fuses rules output with LLM output, detects per-field conflicts, runs normalizers, re-validates against the Zod schema, and runs custom validators. `merge.defaultFieldPolicy` exposes the built-in fusion rules.
- `prompt` namespace — `prompt.build(schema, partial, options?)` emits an `LlmRequest` (`systemPrompt`, `userContent`, `responseSchema`, `knownValues`) restricted to fields missing from the deterministic pass. `prompt.parse(raw, missing, schema)` is a permissive parser that validates each field individually via Zod, drops invalid or unexpected keys, and never throws.
- `validator` namespace — `validator.of<T>()` returns `{ field, crossField }` factories bound to the data shape `T`, so predicates are fully typed from the field name.
- `LlmProvider` contract — single-method interface (`complete(request) → { values }`) consumers implement to wire any backend (OpenAI, Anthropic, Ollama, custom HTTP, ...). No vendor SDK is pulled into the import graph.
- Per-field confidence scoring, conflict detection (`flag` / `prefer-rule` / `prefer-llm` strategies), and extraction metadata (`durationMs`, rule/LLM field counts).
- Full TypeScript `.d.ts` output with JSDoc on every public type, method and configuration field.
- Example wiring a local Ollama runtime under `examples/ollama.ts`.
