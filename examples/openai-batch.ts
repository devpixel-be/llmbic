/**
 * End-to-end example: pushing an llmbic extraction through the OpenAI Batch
 * API (~50% cheaper than realtime chat completions, 24h turnaround SLA).
 *
 * Run: `OPENAI_API_KEY=sk-... npm run example:openai-batch`
 *
 * Not part of `npm test`: hitting the real Batch API requires an account,
 * credits, and up to 24h of wall-clock time. In practice you kick off the
 * batch from one process and pick up the results from another; here both
 * phases are chained for readability.
 *
 * The llmbic 4-step pipeline maps 1:1 onto the Batch API lifecycle:
 *
 *   1. `extractSync(content)`            deterministic rules, instant
 *   2. `extractor.prompt(content, ...)`  build the LLM request payload
 *   3. upload JSONL -> create batch -> poll -> download output
 *   4. `extractor.parse(raw)` + `extractor.merge(partial, llmResult, content)`
 *
 * Steps 1, 2 and 4 are pure and synchronous: persist the `partial` object
 * between (2) and (4).
 */

import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import OpenAI from 'openai';
import { createExtractor } from '../src/extractor.js';
import { prompt } from '../src/prompt.js';
import { rule } from '../src/rules.js';
import type { ExtractionRule } from '../src/types/rule.types.js';

const orderSchema = z.object({
  orderNumber: z.string(),
  issuedOn: z.string(),
  currency: z.enum(['EUR', 'USD', 'GBP']),
  total: z.number(),
  customer: z.string(),
  notes: z.string().nullable(),
});

const orderRules: ExtractionRule[] = [
  rule.regex('orderNumber', /Order\s+#([A-Z0-9-]+)/, 0.95),
  rule.regex('issuedOn', /Issued on:\s*(\d{4}-\d{2}-\d{2})/, 0.9),
  rule.regex('currency', /Currency:\s*(EUR|USD|GBP)/, 0.9),
  rule.regex('total', /Total:\s*[€$£]\s*([\d.]+)/, 0.85, (match) => Number(match[1])),
];

const documents = [
  {
    id: 'order-0001',
    markdown: `
# Order #ORD-2026-0412

Issued on: 2026-03-14
Currency: EUR

Total: € 30.30

Billed to Alice Durand, Studio Orange.
Please deliver before Friday; leave the parcel at the reception if we are out.
    `.trim(),
  },
  {
    id: 'order-0002',
    markdown: `
# Order #ORD-2026-0518

Issued on: 2026-04-02
Currency: USD

Total: $ 112.00

Billed to Bob Nguyen, Nguyen & Co.
No gift wrapping. Contact customer before dispatch.
    `.trim(),
  },
];

const MODEL = 'gpt-4o-mini';
const SYSTEM_PROMPT =
  'You extract structured fields from an order document. Return ONLY the JSON object that matches the provided schema.';

async function main() {
  const client = new OpenAI();

  // No `llm` in the config: the batch flow drives the LLM call itself, so
  // there is no provider to plug in. The extractor still owns steps 1 and 4
  // (extractSync, parse, merge), and `prompt.build` handles step 2 directly.
  const extractor = createExtractor({ schema: orderSchema, rules: orderRules });

  // Step 1 + 2: run rules, build an LLM request per document, keep the
  // partials in memory so step 4 can fuse them back.
  const prepared = documents.map((doc) => {
    const partial = extractor.extractSync(doc.markdown);
    const request = prompt.build(orderSchema, partial, doc.markdown, {
      systemPrompt: SYSTEM_PROMPT,
    });
    return { id: doc.id, markdown: doc.markdown, partial, request };
  });

  // Step 3a: convert each request into a Batch API line (Chat Completions
  // + Structured Outputs). The `custom_id` is how we map results back to
  // the partials we kept above.
  const jsonl = prepared
    .map((entry) =>
      JSON.stringify({
        custom_id: entry.id,
        method: 'POST',
        url: '/v1/chat/completions',
        body: {
          model: MODEL,
          messages: [
            { role: 'system', content: entry.request.systemPrompt },
            { role: 'user', content: entry.request.userContent },
          ],
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'order_extraction',
              strict: true,
              schema: entry.request.responseSchema,
            },
          },
        },
      }),
    )
    .join('\n');

  // Step 3b: upload, create batch, poll.
  const file = await client.files.create({
    file: await OpenAI.toFile(Buffer.from(jsonl, 'utf8'), 'batch.jsonl'),
    purpose: 'batch',
  });
  const batch = await client.batches.create({
    input_file_id: file.id,
    endpoint: '/v1/chat/completions',
    completion_window: '24h',
  });
  console.log(`-> batch ${batch.id} submitted`);

  let status = batch;
  while (status.status !== 'completed' && status.status !== 'failed') {
    await sleep(30_000);
    status = await client.batches.retrieve(batch.id);
    console.log(`  status: ${status.status}`);
  }
  if (status.status === 'failed' || !status.output_file_id) {
    throw new Error(`batch ${batch.id} failed: ${JSON.stringify(status.errors)}`);
  }

  // Step 3c: download the output JSONL.
  const outputFile = await client.files.content(status.output_file_id);
  const outputText = await outputFile.text();
  const responsesById = new Map<string, unknown>();
  for (const line of outputText.split('\n').filter(Boolean)) {
    const parsed = JSON.parse(line) as {
      custom_id: string;
      response: { body: { choices: Array<{ message: { content: string } }> } };
    };
    responsesById.set(parsed.custom_id, parsed.response.body.choices[0]?.message.content);
  }

  // Step 4: per-document parse + merge.
  for (const entry of prepared) {
    const raw = responsesById.get(entry.id);
    const llmResult = extractor.parse(raw);
    const result = extractor.merge(entry.partial, llmResult, entry.markdown);

    console.log(`\n── ${entry.id} ────────────────────────────────`);
    console.dir(result.data, { depth: null });
    console.log('confidence:', result.confidence);
    console.log('conflicts:', result.conflicts);
  }
}

main().catch((error) => {
  console.error('openai-batch failed:', error);
  process.exit(1);
});
