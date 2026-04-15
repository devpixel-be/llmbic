/**
 * End-to-end example wiring llmbic to a local Ollama runtime.
 *
 * Run: `OLLAMA_MODEL=gemma3:27b npm run example:ollama`
 *
 * Not part of `npm test` — hitting a live LLM is slow and non-deterministic.
 * The pipeline exercised here is the full one: rules → prompt.build →
 * provider.complete → prompt.parse → merge, against a real structured-output
 * backend.
 *
 * The `LlmProvider` below is inlined on purpose: llmbic ships no
 * vendor-specific adapters, and this ~12-line wrapper IS the integration
 * pattern the README documents. Copy/adapt freely for your own backend.
 */

import process from 'node:process';
import { z } from 'zod';
import { Ollama } from 'ollama';
import { createExtractor } from '../src/extractor.js';
import { rule } from '../src/rules.js';
import type { ExtractionRule } from '../src/types/rule.types.js';
import type { LlmProvider } from '../src/types/provider.types.js';

const orderSchema = z.object({
  orderNumber: z.string(),
  issuedOn: z.string(),
  currency: z.enum(['EUR', 'USD', 'GBP']),
  total: z.number(),
  customer: z.string(),
  paymentMethod: z.enum(['card', 'transfer', 'cash', 'crypto']),
  shippingMethod: z.enum(['standard', 'express', 'pickup']),
  isGift: z.boolean(),
  vatNumber: z.string().nullable(),
  notes: z.string().nullable(),
});

const orderRules: ExtractionRule[] = [
  rule.regex('orderNumber', /Order\s+#([A-Z0-9-]+)/, 0.95),
  rule.regex('issuedOn', /Issued on:\s*(\d{4}-\d{2}-\d{2})/, 0.9),
  rule.regex('currency', /Currency:\s*(EUR|USD|GBP)/, 0.9),
  rule.regex('total', /Grand total:\s*[€$£]\s*([\d.]+)/, 0.85, (match) => Number(match[1])),
];

const markdown = `
# Order #ORD-2026-0617

Issued on: 2026-05-22
Currency: EUR

| Item            | Qty | Unit  | Line total |
|---|---|---|---|
| Graphite pencil | 12  | € 0.90 | € 10.80   |
| Sketchbook A5   | 3   | € 6.50 | € 19.50   |
| Gift wrapping   | 1   | € 4.00 | €  4.00   |

Subtotal: € 34.30
Shipping (express courier, next-day): € 8.00
Grand total: € 42.30

Billed to Alice Durand, Studio Orange, VAT BE0123.456.789.
Paid by bank transfer on the same day.
Please wrap as a gift — this is a birthday present.
Notes: leave at the reception if nobody is in; do NOT ring the neighbors.
`.trim();

function ollamaProvider(client: Ollama, model: string): LlmProvider {
  return {
    async complete(request) {
      const response = await client.chat({
        model,
        messages: [
          { role: 'system', content: request.systemPrompt },
          { role: 'user', content: request.userContent },
        ],
        format: request.responseSchema,
      });
      return { values: JSON.parse(response.message.content) as Record<string, unknown> };
    },
  };
}

async function main() {
  const model = process.env.OLLAMA_MODEL ?? 'gemma3:27b';
  const host = process.env.OLLAMA_HOST ?? 'http://localhost:11434';
  console.log(`→ model: ${model}`);
  console.log(`→ host:  ${host}\n`);

  const extractor = createExtractor({
    schema: orderSchema,
    rules: orderRules,
    llm: {
      provider: ollamaProvider(new Ollama({ host }), model),
      systemPrompt:
        'You extract structured fields from an order document. Return ONLY the JSON object that matches the provided schema — no preamble, no markdown fences.',
    },
  });

  const result = await extractor.extract(markdown);

  console.log('── data ─────────────────────────────────────');
  console.dir(result.data, { depth: null });
  console.log('\n── confidence ───────────────────────────────');
  console.dir(result.confidence, { depth: null });
  console.log('\n── conflicts ────────────────────────────────');
  console.dir(result.conflicts, { depth: null });
  console.log('\n── validation ───────────────────────────────');
  console.dir(result.validation, { depth: null });
  console.log('\n── meta ─────────────────────────────────────');
  console.dir(result.meta, { depth: null });
}

main().catch((error) => {
  console.error('smoke-ollama failed:', error);
  process.exit(1);
});
