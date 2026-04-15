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
import { createExtractor, rule, confidence } from 'llmbic';

const InvoiceSchema = z.object({
  total: z.number().nullable(),
  currency: z.string().nullable(),
  vendor: z.string().nullable(),
  date: z.string().nullable(),
});

const extractor = createExtractor({
  schema: InvoiceSchema,
  rules: [
    rule('total', (text) => {
      const m = text.match(/Total[:\s]*(\d[\d.,\s]+)\s*€/i);
      if (!m) return null;
      return confidence(parseFloat(m[1].replace(/[\s.]/g, '').replace(',', '.')), 1.0);
    }),
    rule('currency', (text) => {
      if (/€|EUR/i.test(text)) return confidence('EUR', 1.0);
      if (/\$|USD/i.test(text)) return confidence('USD', 1.0);
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
import { createExtractor, rule, confidence } from 'llmbic';
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

### Conflict detection

When a rule and the LLM extract different values for the same field, Llmbic flags it:

```typescript
result.conflicts;
// [{ field: 'total', ruleValue: 1250, ruleConfidence: 1.0, llmValue: 1520 }]
```

Three conflict strategies: `'flag'` (default — keep rule value, record conflict), `'prefer-rule'`, or `'prefer-llm'`.

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
import { validators } from 'llmbic';

const { field, crossField } = validators<MySchemaShape>();

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

**OpenAI** (Chat Completions + Structured Outputs):

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
| `schema` | `ZodObject` | yes | Output schema |
| `rules` | `ExtractionRule[]` | yes | Deterministic extraction rules |
| `llm` | `{ provider, systemPrompt, defaultConfidence? }` | no | LLM configuration. Omit for rules-only mode. |
| `normalizers` | `Normalizer[]` | no | Post-merge transformations |
| `validators` | `Validator[]` | no | Output invariants |
| `conflictStrategy` | `'flag' \| 'prefer-rule' \| 'prefer-llm'` | no | Default: `'flag'` |
| `logger` | `Logger` | no | Injectable logger (compatible with Pino, Winston, console) |

### `rule(field, extractFn)`

Factory to create an `ExtractionRule`.

### `confidence(value, score)`

Factory to create a `RuleMatch` with a confidence score.

### `validators<T>()`

Factory bound to the data shape `T`. Returns `{ field, crossField }`:

- `field(name, rule, checkFn, message, severity?)` — single-field validator. `checkFn` receives the precise type of the field (`T[name]`).
- `crossField(rule, checkFn, message, severity?)` — whole-object validator, produces a violation without a `field` property.

Binding `T` once lets TypeScript infer each field's type from the field name, so predicates are fully typed without manual annotations.

### Extractor methods

| Method | Sync | Description |
|--------|------|-------------|
| `extract(content)` | async | Full pipeline: rules → LLM → merge → validate |
| `extractSync(content)` | sync | Rules only. Returns partial result + missing fields. |
| `prompt(content, partial)` | sync | Builds LLM prompt for missing fields only. |
| `parse(raw)` | sync | Parses raw LLM JSON response. |
| `merge(partial, llmResult, content)` | sync | Merges rules + LLM, detects conflicts, normalizes, validates. |

## License

MIT

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).
