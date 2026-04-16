# Llmbic

[![npm version](https://img.shields.io/npm/v/llmbic.svg)](https://www.npmjs.com/package/llmbic)
[![CI](https://github.com/devpixel-be/llmbic/actions/workflows/ci.yml/badge.svg)](https://github.com/devpixel-be/llmbic/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/llmbic.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/llmbic.svg)](https://nodejs.org)

Hybrid data extraction — deterministic rules + LLM fallback, with per-field confidence scoring.

The name folds **LLM** into [*lambic*](https://en.wikipedia.org/wiki/Lambic), the Belgian beer made by blending wild fermentation with a controlled process. Same idea here: LLMs are unpredictable, rules are rigid, and the mix produces something reliable.

## Why

Extracting structured data from unstructured text is a solved problem — until you need it to be *reliable*. Rules (regex, parsers) are deterministic but brittle. LLMs understand context but hallucinate. Neither is enough alone.

Llmbic combines both: deterministic rules extract what they can with full confidence, the LLM fills in the gaps, and a merge layer detects conflicts between the two. Every field carries a confidence score. You know exactly what's trustworthy and what needs review.

## Install

```bash
npm install llmbic
```

Llmbic has a single dependency: [Zod](https://zod.dev). No vendor SDK is pulled in — you bring your own LLM provider via the 1-method `LlmProvider` interface (see "Writing a provider" below).

## Quick start

### Rules-only (no LLM, no network)

```typescript
import { z } from 'zod';
import { createExtractor, rule } from 'llmbic';

const InvoiceSchema = z.object({
  total: z.number().nullable(),
  currency: z.string().nullable(),
  vendor: z.string().nullable(),
  date: z.string().nullable(),
});

const extractor = createExtractor({
  schema: InvoiceSchema,
  rules: [
    rule.create('total', (text) => {
      const m = text.match(/Total[:\s]*(\d[\d.,\s]+)\s*€/i);
      if (!m) return null;
      return rule.confidence(parseFloat(m[1].replace(/[\s.]/g, '').replace(',', '.')), 1.0);
    }),
    rule.create('currency', (text) => {
      if (/€|EUR/i.test(text)) return rule.confidence('EUR', 1.0);
      if (/\$|USD/i.test(text)) return rule.confidence('USD', 1.0);
      return null;
    }),
  ],
});

const result = await extractor.extract(markdownContent);

console.log(result.data);
// { total: 1250.00, currency: 'EUR', vendor: null, date: null }

console.log(result.confidence);
// { total: 1.0, currency: 1.0, vendor: null, date: null }

console.log(result.missing);
// ['vendor', 'date']
```

### Rules + LLM

```typescript
import { createExtractor, rule } from 'llmbic';
import type { LlmProvider } from 'llmbic';
import OpenAI from 'openai';

const client = new OpenAI();
const provider: LlmProvider = {
  async complete(request) {
    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: request.systemPrompt },
        { role: 'user', content: request.userContent },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'extraction', strict: true, schema: request.responseSchema },
      },
    });
    return { values: JSON.parse(response.choices[0].message.content!) };
  },
};

const extractor = createExtractor({
  schema: InvoiceSchema,
  rules: [
    // ... same rules as above
  ],
  llm: {
    provider,
    systemPrompt: 'Extract invoice data from the following document.',
  },
});

const result = await extractor.extract(markdownContent);

console.log(result.data);
// { total: 1250.00, currency: 'EUR', vendor: 'Acme Corp', date: '2026-04-14' }

console.log(result.confidence);
// { total: 1.0, currency: 1.0, vendor: 0.7, date: 0.7 }

console.log(result.conflicts);
// [] — no disagreement between rules and LLM
```

### Batch / async mode (for OpenAI Batch API, job queues, etc.)

When you manage the LLM call yourself (batching, polling, custom transport), use the 4-step API:

```typescript
// Step 1 — Deterministic extraction (sync, instant)
const partial = extractor.extractSync(markdown);

// Step 2 — Build the LLM request (you send it however you want)
const llmRequest = extractor.prompt(markdown, partial);
// → { systemPrompt, userContent, responseSchema, knownValues }

// ... submit to OpenAI Batch API, poll later, get the response ...

// Step 3 — Parse the raw LLM response
const llmResult = extractor.parse(rawJsonResponse);

// Step 4 — Merge everything (fusion + conflict detection + validation)
const result = extractor.merge(partial, llmResult, markdown);
```

Steps 1, 2 and 4 are pure and synchronous: persist `partial` between (2) and (4); the merge re-runs the rules internally so no private state leaks across the async gap.

#### Worked example: OpenAI Batch API

The Batch API expects a JSONL file where each line is a Chat Completions request. Using `extractor.prompt(...)` as the per-document payload builder maps 1:1 onto that format:

```typescript
// For each document, build one JSONL line:
const partial = extractor.extractSync(doc.markdown);
const request = extractor.prompt(doc.markdown, partial);

const line = JSON.stringify({
  custom_id: doc.id,                         // how you'll re-match later
  method: 'POST',
  url: '/v1/chat/completions',
  body: {
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: request.systemPrompt },
      { role: 'user',   content: request.userContent },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'extraction', strict: true, schema: request.responseSchema },
    },
  },
});
```

Upload the JSONL, create the batch, poll until `status === 'completed'`, download the output file. Each output line carries the same `custom_id` so you can map back to the `partial` you kept in memory (or in Redis, or on disk):

```typescript
for (const entry of prepared) {
  const raw = responsesById.get(entry.id);           // from output JSONL
  const llmResult = extractor.parse(raw);
  const result = extractor.merge(entry.partial, llmResult, entry.markdown);
  // ... persist result ...
}
```

End-to-end runnable example (upload + poll + download + merge): [`examples/openai-batch.ts`](./examples/openai-batch.ts). At current OpenAI pricing the Batch API is ~50% cheaper than realtime Chat Completions, with a 24h completion window.

## Features

### Per-field confidence scoring

Every field in the result carries a confidence score (0.0–1.0):

| Source | Confidence |
|--------|-----------|
| Deterministic rule, exact match | 1.0 |
| Deterministic rule, partial match | 0.7–0.9 (you decide) |
| LLM only | configurable default (0.7) |
| Rule + LLM agree | 1.0 |
| Rule + LLM disagree | 0.3 (flagged as conflict) |
| No source | `null` |

### Per-field provenance

Alongside `confidence`, every field carries a `source` describing where the kept value came from. Useful for attributing extractions back to the rule that produced them, monitoring rule quality at scale, or filtering on agreement vs LLM-only fields:

```typescript
result.sources;
// {
//   total:    { kind: 'agreement', ruleId: 'total-eur' },  // rule + LLM agreed
//   currency: { kind: 'rule',      ruleId: 'currency#1' }, // only the rule produced a value
//   vendor:   { kind: 'llm' },                              // only the LLM produced a value
//   date:     { kind: 'flag',      ruleId: 'date-iso' },   // rule and LLM disagreed under flag strategy
//   notes:    null,                                         // missing
// }
```

`ruleId` defaults to `${field}#${declarationIndex}` based on the rule's position in the array - stable as long as you don't reorder. For long-lived production code, declare ids explicitly so refactors don't break observability:

```typescript
rule.create('total', extractTotal, { id: 'total-eur' });
rule.regex('date', /(\d{4}-\d{2}-\d{2})/, 0.95, undefined, { id: 'date-iso' });
```

### Conflict detection

When a rule and the LLM extract different values for the same field, Llmbic flags it:

```typescript
result.conflicts;
// [{ field: 'total', ruleValue: 1250, ruleConfidence: 1.0, llmValue: 1520 }]
```

Three conflict strategies: `'flag'` (default — keep rule value, record conflict), `'prefer-rule'`, or `'prefer-llm'`.

In the default `'fill-gaps'` mode the LLM is only asked about fields the rules could not resolve, so conflicts are impossible. To actually trigger conflict detection, opt into cross-check (see below).

#### Per-field strategies

`policy` is a single strategy applied to every field. When fields have different criticality (a `price` you want to flag vs a `postal_code` your regex always nails vs a free-form `description` you'd rather defer to the LLM), use `policyByField` to override per field. Precedence: library defaults < `policy` < `policyByField[field]`.

```typescript
const extractor = createExtractor({
  schema: ListingSchema,
  rules: [...],
  policy: { strategy: 'flag' },          // default for every field
  policyByField: {
    postal_code: { strategy: 'prefer-rule' },
    description: { strategy: 'prefer-llm' },
  },
});
```

You can override any subset of `FieldMergePolicy` per field - strategy, confidences, even the `compare` callback (e.g. fuzzy equality for free-form strings). TypeScript validates field names against your schema, so typos surface at compile time.

### Cross-check mode

Switch the LLM call from fill-gaps (ask only about missing fields) to cross-check (ask about every schema field, whether the rules resolved it or not):

```typescript
const extractor = createExtractor({
  schema: InvoiceSchema,
  rules: [...],
  llm: {
    provider,
    mode: 'cross-check',
    crossCheckHints: 'unbiased', // default; hides rule values from the LLM
  },
});
```

The merge step now sees two candidates per field and surfaces real disagreements through `result.conflicts`. `crossCheckHints: 'bias'` re-exposes the rule values as hints to save tokens, at the cost of confirmation bias (the LLM tends to agree with what it was shown).

### Rich schemas

The JSON Schema handed to the LLM supports the Zod constructs that show up in real-world extraction targets:

- Primitives: `z.string()`, `z.number()`, `z.boolean()`, `z.enum([...])`.
- Composition: `z.array(...)`, `z.object({...})`, nested arbitrarily.
- Wrappers: `.nullable()`, `.optional()`, `.default(...)`.
- Descriptions: `z.string().describe("price in EUR, tax included")` propagates to the JSON Schema `description` at the declared level (array root vs items, object root vs property), and providers' structured-output features consume it natively. No need to inflate the system prompt with per-field hints.

### Normalizers

Post-merge transformations. Run in sequence, receive the merged data + original content:

```typescript
const extractor = createExtractor({
  schema: MySchema,
  rules: [...],
  normalizers: [
    (data, content) => {
      // Fix a known data quality issue
      if (data.price && data.price < 100) data.price = null;
      return data;
    },
  ],
});
```

### Validators (invariants)

Check the final output for logical consistency:

```typescript
import { validator } from 'llmbic';

const { field, crossField } = validator.of<MySchemaShape>();

const extractor = createExtractor({
  schema: MySchema,
  rules: [...],
  validators: [
    field('price', 'price_positive', (v) => v === null || v > 0, 'Price must be positive'),
    crossField('date_format', (d) => !d.date || /^\d{4}-\d{2}-\d{2}$/.test(d.date), 'Date must be YYYY-MM-DD'),
  ],
});

result.validation;
// { valid: true, violations: [] }
// or { valid: false, violations: [{ field: 'price', rule: 'price_positive', message: '...', severity: 'error' }] }
```

### Request / response transformers

Two optional hooks let you intercept the LLM exchange without wrapping the provider yourself: `transformRequest` runs after `prompt.build` and before `provider.complete`; `transformResponse` runs after `prompt.parse` and before the merge. Both can be async; errors propagate.

```typescript
const extractor = createExtractor({
  schema: ContactSchema,
  rules: [...],
  llm: {
    provider,
    transformRequest: (request, content) => ({
      ...request,
      systemPrompt: `Language: ${detectLocale(content)}\n${request.systemPrompt}`,
    }),
  },
});
```

Common patterns:

- **PII redaction (RGPD)**: replace emails / phones / IDs with placeholders in `userContent`, stash the originals in `knownValues` under a private key, restore them in `transformResponse`. Worked example: [`examples/pii-redaction.ts`](./examples/pii-redaction.ts).
- **Locale tagging**: prepend `Language: ...` to `systemPrompt` after caller-side detection.
- **Caching**: wrap your `LlmProvider.complete` directly - cleaner than short-circuiting in a hook, since it sits at the actual transport boundary.

## Writing a provider

Llmbic does not ship vendor-specific adapters. The `LlmProvider` contract is a single method — wiring to any backend (OpenAI, Anthropic, Ollama, vLLM, Gemini, custom HTTP, ...) is ~10 lines you write and own.

```typescript
import type { LlmProvider } from 'llmbic';

const provider: LlmProvider = {
  async complete(request) {
    const response = await fetch('https://api.example.com/v1/complete', {
      method: 'POST',
      body: JSON.stringify({
        system: request.systemPrompt,
        user: request.userContent,
        schema: request.responseSchema,
      }),
    });
    const data = await response.json();
    return { values: data.output };
  },
};
```

Ready-made snippets for common backends:

**OpenAI** (Chat Completions + Structured Outputs). The response schema llmbic emits always carries `additionalProperties: false`, so `strict: true` works out of the box:

```typescript
const client = new OpenAI();
const provider: LlmProvider = {
  async complete(request) {
    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: request.systemPrompt },
        { role: 'user', content: request.userContent },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'extraction', strict: true, schema: request.responseSchema },
      },
    });
    return { values: JSON.parse(response.choices[0].message.content!) };
  },
};
```

**Anthropic** (Messages API + forced tool):

```typescript
const client = new Anthropic();
const provider: LlmProvider = {
  async complete(request) {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      system: request.systemPrompt,
      messages: [{ role: 'user', content: request.userContent }],
      tools: [{ name: 'extraction', input_schema: request.responseSchema }],
      tool_choice: { type: 'tool', name: 'extraction' },
    });
    const toolUse = response.content.find((b) => b.type === 'tool_use');
    return { values: toolUse!.input as Record<string, unknown> };
  },
};
```

**Ollama** (native `format` — JSON Schema, requires Ollama 0.5+):

```typescript
const client = new Ollama();
const provider: LlmProvider = {
  async complete(request) {
    const response = await client.chat({
      model: 'llama3.1',
      messages: [
        { role: 'system', content: request.systemPrompt },
        { role: 'user', content: request.userContent },
      ],
      format: request.responseSchema,
    });
    return { values: JSON.parse(response.message.content) };
  },
};
```

Observability (token usage, latency, cost accounting) is out of scope — wrap the `complete` call in whatever telemetry you already use.

## Design decisions

- **One dependency** — Zod only. No vendor SDK ever enters the import graph; you bring your own LLM provider (see "Writing a provider").
- **No retry** — If the LLM returns invalid data, `parse()` does best-effort parsing (valid fields kept, invalid ignored). Retry is an orchestration concern.
- **No streaming** — Llmbic works with complete results. Streaming is a transport concern.
- **No chunking** — One content = one extraction. If your content is too long, split it before calling Llmbic.
- **Normalizers mutate** — For pragmatic reasons, normalizers receive and return the same object. The `merge()` function copies the data first, so the original is never modified.
- **Rules are sync** — Extraction rules are pure synchronous functions. If you need async lookups, do them before creating the rule.

## API reference

### `createExtractor(config)`

Creates an extractor instance. Config:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `schema` | `ZodObject` | yes | Output schema (drives field enumeration and re-validation). |
| `rules` | `ExtractionRule[]` | yes | Deterministic extraction rules. |
| `llm` | `ExtractorLlmConfig` | no | LLM fallback. Omit for rules-only mode. See below. |
| `normalizers` | `Normalizer<T>[]` | no | Post-merge transformations, run in declared order. |
| `validators` | `Validator<ExtractedData<T>>[]` | no | Invariants populating `result.validation`. |
| `policy` | `Partial<FieldMergePolicy>` | no | Overrides the per-field merge policy (conflict strategy, confidence defaults, equality) for every field. |
| `policyByField` | `{ [K in keyof T]?: Partial<FieldMergePolicy> }` | no | Per-field overrides applied on top of `policy`. Precedence: defaults < `policy` < `policyByField[field]`. |
| `logger` | `Logger` | no | Pino/Winston/console-compatible. Warnings from `rule.apply` and `merge.apply` flow through. |

`ExtractorLlmConfig`:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `provider` | `LlmProvider` | yes | Single-method adapter the extractor calls. |
| `systemPrompt` | `string` | no | Overrides the built-in system prompt. |
| `mode` | `'fill-gaps' \| 'cross-check'` | no | `'fill-gaps'` (default) asks the LLM only about fields the rules did not resolve. `'cross-check'` asks about every schema field so `merge.apply` can surface agreements / conflicts. |
| `crossCheckHints` | `'bias' \| 'unbiased'` | no | In cross-check mode only. `'unbiased'` (default) hides rule values from the LLM for genuine disagreement detection; `'bias'` re-exposes them to save tokens. |
| `transformRequest` | `(request, content) => LlmRequest \| Promise<LlmRequest>` | no | Hook called with the built request before `provider.complete`. PII redaction, locale tagging, etc. |
| `transformResponse` | `(result, request) => LlmResult \| Promise<LlmResult>` | no | Hook called with the parsed LLM result before the merge. PII restoration, post-processing, etc. |

### `rule` namespace

| Member | Signature | Description |
|---|---|---|
| `rule.create` | `(field, extract, options?) => ExtractionRule` | Declare a rule. `extract(content)` returns a `RuleMatch` or `null`. `options.id` sets the stable identifier surfaced in `result.sources`. |
| `rule.regex` | `(field, pattern, score, transform?, options?) => ExtractionRule` | Regex-based rule. On match, capture group 1 (or the full match) is fed to `transform`. `options.id` sets the stable identifier surfaced in `result.sources`. |
| `rule.confidence` | `(value, score) => RuleMatch` | Wrap a value and a confidence score; sugar for custom `extract` callbacks. |
| `rule.apply` | `(content, rules, schema, logger?) => RulesResult` | Run every rule, pick the highest-confidence match per field, type-check against the schema. |

### `validator.of<T>()`

Binds a target data shape `T` and returns two validator builders:

- `field(name, ruleName, check, message, severity?)`: single-field validator. `check(value, data)` receives the precise type of the field (`T[name]`) as first argument.
- `crossField(ruleName, check, message, severity?)`: whole-object validator, produces a violation without a `field` property.

Binding `T` once lets TypeScript infer each field's type from the field name, so predicates are fully typed without manual annotations.

### Extractor methods

| Method | Sync | Description |
|--------|------|-------------|
| `extract(content)` | async | Full pipeline: rules -> LLM (if configured) -> merge -> normalize -> validate. |
| `extractSync(content)` | sync | Rules only. Returns the partial result + `missing` fields. |
| `prompt(content, partial)` | sync | Builds the LLM request. Covers `partial.missing` in fill-gaps mode, every schema field in cross-check mode. |
| `parse(raw)` | sync | Parses a raw LLM JSON response, validating each field individually. Never throws. |
| `merge(partial, llmResult, content)` | sync | Merges rules + LLM, detects conflicts, normalizes, validates. |

## License

MIT

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).
