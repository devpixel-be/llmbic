# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.5.0] - 2026-04-23

Non-breaking. Normalizer mutations now show up in `ExtractionResult` as a dedicated, ordered list so callers can audit exactly what each post-fusion transformation did: which field, which normalizer, before-and-after values. Complements `sources[field]` (which still describes the post-fusion origin) - the two are orthogonal signals.

### Added

- `ExtractionResult.normalizerMutations: NormalizerMutation<T>[]` - one entry per `(normalizer, field)` where the field's value changed during that normalizer's pass, in the order they occurred. Empty array when no normalizers ran or none mutated any field. Enables audit, observability, and regression diagnosis on normalizer changes. Existing consumers keep working unchanged - the field is additive and its neutral value is `[]`.
- `NormalizerMutation<T>` public type - `{ normalizerId, field, before, after, step }`. `before` / `after` are captured verbatim (no diffing, no deep-cloning); `step` is the zero-based index of the normalizer in the configured pipeline so consumers can order or group mutations produced by the same pass.
- `defineNormalizer<T, TContext = unknown>(id, apply)` helper - attaches a stable `id` to a normalizer, useful for arrow functions which would otherwise resolve to `'anonymous'` in `NormalizerMutation.normalizerId`. Resolution order for a normalizer's id: `fn.id` (non-empty string) -> `fn.name` -> `'anonymous'`; regular named functions already pick up their name for free.

## [1.4.0] - 2026-04-18

Non-breaking. Normalizers can now read the same caller-provided `context` the rules see, so post-merge cross-field fix-ups no longer have to be closed over at extractor-declaration time. Typical use: a normalizer that reconciles extracted fields against the `sourceUrl` or per-tenant configuration passed to `extract`.

### Added

- `Normalizer<T, TContext = unknown>` - second optional generic type parameter describing the shape of the per-call context forwarded to the normalizer's third argument. Defaults to `unknown`, so context-unaware normalizers and legacy code compile unchanged.
- `Normalizer(data, content, context?)` - third optional argument, left `undefined` when the caller passes no context.
- `MergeApplyOptions<T, TContext = unknown>` - second optional generic parameter shared with `Normalizer`, surfacing as `normalizers?: Normalizer<T, TContext>[]`.
- `merge.apply<S, TContext>(schema, rulesResult, llmResult, content, options?, context?)` - sixth optional argument forwarded verbatim to every normalizer.
- `ExtractorConfig<S, TContext>.normalizers` now types as `Normalizer<z.infer<S>, TContext>[]`, so the context flowing through rules reaches normalizers with the same compile-time shape.
- `Extractor.merge(partial, llmResult, content, context?)` - fourth optional argument. Rules are still not re-evaluated, but normalizers run here too; accepting `context` keeps them consistent with `Extractor.extract` / `Extractor.extractSync`.

## [1.3.0] - 2026-04-18

Non-breaking. Rules can now read a caller-provided `context` object alongside `content`, so per-call metadata (locale, tenant configuration, feature flags) no longer has to be captured in rule closures at declaration time.

### Added

- `ExtractionRule<TContext = unknown>` - optional generic type parameter describing the shape of a per-call context forwarded to `extract`. Defaults to `unknown`, so context-unaware rules and legacy code compile unchanged.
- `ExtractionRule.extract(content, context?)` - second optional argument, forwarded verbatim by `rule.apply` / `Extractor.extract` / `Extractor.extractSync`. Left `undefined` when the caller passes no context.
- `rule.create<TContext>(field, extract, options?)` - `create` is now generic over `TContext`, so typed contexts flow from the callback signature to the returned `ExtractionRule<TContext>`. `rule.regex` stays context-unaware and remains assignable to any `ExtractionRule<TContext>[]` via contextual parameter contravariance.
- `rule.apply<S, TContext>(content, rules, schema, logger?, context?)` - fifth optional argument passed through to every rule's `extract` callback.
- `ExtractorConfig<S, TContext = unknown>` and `Extractor<T, TContext = unknown>` - second optional generic parameter shared with the rules array. `Extractor.extract(content, context?)` and `Extractor.extractSync(content, context?)` forward `context` to `rule.apply`. `Extractor.merge` does not re-evaluate rules and accepts no `context`.

### Docs

- `CONTRIBUTING.md` - documents the 5-step release procedure (tests, bump, doc, tag, publish) to keep future releases aligned with the SemVer + npm publish lifecycle.

## [1.2.0] - 2026-04-16

Non-breaking. Production-readiness pass: per-field provenance, per-field merge policy, and pre/post LLM transformers. Token / cost tracking deliberately stays out of scope - `LlmProvider` keeps observability as a caller concern; wrap your `complete` for telemetry.

### Added

- `ExtractionResult.sources` - per-field origin of the kept value, as a `FieldSource` discriminated union (`'rule' | 'llm' | 'agreement' | 'flag'`). Variants involving a rule carry the `ruleId` of the rule that produced the match. Use it to attribute extractions back to specific rules, monitor rule quality at scale, or filter results on agreement vs LLM-only fields.
- `ExtractionRule.id` and `rule.create` / `rule.regex` `options.id` - declare a stable identifier surfaced in `ExtractionResult.sources`. When omitted, `rule.apply` auto-generates `${field}#${declarationIndex}` based on the rule's position in the array.
- `MergeApplyOptions.policyByField` and `ExtractorConfig.policyByField` - per-field overrides of `FieldMergePolicy` (strategy, confidences, compare). Precedence: defaults < `policy` < `policyByField[field]`. TypeScript validates field names against the schema. Lets a single extractor flag conflicts on critical fields, prefer rules on parser-friendly fields, and prefer the LLM on free-form fields without writing custom merge code.
- `ExtractorLlmConfig.transformRequest` / `transformResponse` - async hooks called around `provider.complete`. `transformRequest` rewrites the built `LlmRequest` (PII redaction, locale tagging); `transformResponse` rewrites the parsed `LlmResult` before the merge step (PII restoration, post-processing). Errors propagate, no implicit catch.
- `examples/pii-redaction.ts` - runnable, offline demo of the redact-then-restore pattern using `transformRequest` + `transformResponse` (also wired as `npm run example:pii-redaction`).

### Public types

- `FieldSource` exported from the package root.
- `RulesResult.sourceIds` (optional) - populated by `rule.apply`, consumed by `merge.apply` to compute `ExtractionResult.sources`. External callers building `RulesResult` by hand can omit it; provenance simply falls back to an empty `ruleId`.
- `ExtractionRule` gains optional `id`. `RuleMatch`, `FieldMergeResult` and `merge.field`'s signature are unchanged - provenance is computed from the merge outcome plus the policy, not stored on the per-field primitive.

## [1.1.0] - 2026-04-16

Non-breaking. Unblocks hybrid workflows that rely on nested schemas, agreement/conflict detection, and extractor-level merge options.

### Added

- `prompt.build` now supports `z.array(...)`, `z.object(...)`, `z.optional(...)` and `z.default(...)` in the response JSON Schema. Optional fields are preserved in `properties` but excluded from `required`.
- Cross-check mode on `prompt.build` and `ExtractorLlmConfig`: `mode: 'cross-check'` asks the LLM about every schema field, not just `partial.missing`, enabling the per-field agreement / conflict machinery in `merge.apply`. `crossCheckHints: 'bias' | 'unbiased'` (default `unbiased`) controls whether rule values are surfaced to the LLM as hints.
- `ExtractorConfig` now accepts `normalizers`, `validators`, `policy` and `logger` directly; previously these had to be threaded into a manual `merge.apply` call. The options are forwarded to every internal merge, so `extract`, `extractSync` and `extractor.merge` all honor them.
- Zod `.describe("...")` (equivalent to `.meta({ description })`) is now propagated to the generated JSON Schema at the level it was declared; providers' structured-output features consume it natively, so per-field prompt guidance no longer requires an expanded system prompt.
- README "Batch / async mode" section expanded with a worked OpenAI Batch API example (JSONL shape, upload / poll / download / merge), plus a full runnable script at `examples/openai-batch.ts`.

### Fixed

- Object schemas emitted by `prompt.build` now carry `additionalProperties: false`, matching the requirement of OpenAI Chat Completions Structured Outputs with `strict: true`. Other providers (Anthropic tool use, Ollama JSON Schema) ignore the extra key. Aligned with `prompt.parse` which already drops unexpected fields with a warning.
- `createExtractor` was not forwarding the configured `logger` to `rule.apply`, so schema-rejection warnings from the rules pass were silently dropped. The logger is now plumbed through every phase.

### Public types

- `PromptBuildMode`, `CrossCheckHints`, `PromptBuildOptions` exported from the package root.
- `ExtractorConfig<S>` gains optional `normalizers`, `validators`, `policy`, `logger`.
- `ExtractorLlmConfig` gains optional `mode`, `crossCheckHints`.

## [1.0.0] - 2026-04-15

Initial public release.

### Added

- `createExtractor(config)` - factory binding a Zod schema, deterministic rules and an optional LLM fallback into an extractor with `extract`, `extractSync`, `prompt`, `parse` and `merge` methods. Covers both one-shot async extraction and 4-step batch flows (extractSync -> prompt -> external LLM call -> parse -> merge).
- `rule` namespace - `rule.create(field, extractFn)`, `rule.regex(field, pattern, score, transform?)`, `rule.confidence(value, score)`, `rule.apply(content, rules, schema, logger?)`. Deterministic rules are pure synchronous functions returning typed matches with a confidence score in `[0, 1]`.
- `merge` namespace - `merge.apply(schema, rulesResult, llmResult, content, options?)` fuses rules output with LLM output, detects per-field conflicts, runs normalizers, re-validates against the Zod schema, and runs custom validators. `merge.defaultFieldPolicy` exposes the built-in fusion rules.
- `prompt` namespace - `prompt.build(schema, partial, options?)` emits an `LlmRequest` (`systemPrompt`, `userContent`, `responseSchema`, `knownValues`) restricted to fields missing from the deterministic pass. `prompt.parse(raw, missing, schema)` is a permissive parser that validates each field individually via Zod, drops invalid or unexpected keys, and never throws.
- `validator` namespace - `validator.of<T>()` returns `{ field, crossField }` factories bound to the data shape `T`, so predicates are fully typed from the field name.
- `LlmProvider` contract - single-method interface (`complete(request) -> { values }`) consumers implement to wire any backend (OpenAI, Anthropic, Ollama, custom HTTP, ...). No vendor SDK is pulled into the import graph.
- Per-field confidence scoring, conflict detection (`flag` / `prefer-rule` / `prefer-llm` strategies), and extraction metadata (`durationMs`, rule/LLM field counts).
- Full TypeScript `.d.ts` output with JSDoc on every public type, method and configuration field.
- Example wiring a local Ollama runtime under `examples/ollama.ts`.
