/**
 * Example showing how to use `transformRequest` / `transformResponse` to
 * redact PII from the LLM payload and restore it from the response.
 *
 * Pattern:
 * - `transformRequest` rewrites `userContent` so emails / phone numbers
 *   never reach the provider; the originals are stashed in `knownValues`
 *   under a private `_pii` key (kept locally - providers ignore unknown
 *   metadata, and `prompt.parse` drops fields not in the schema).
 * - `transformResponse` walks the LLM-produced values and restores any
 *   placeholder it encounters.
 *
 * Runs offline against a stub provider that simply echoes redacted tokens
 * back, so the example stays deterministic in `npm run example:pii`.
 */

import { z } from 'zod';
import { createExtractor } from '../src/extractor.js';
import { rule } from '../src/rules.js';
import type { LlmProvider } from '../src/types/provider.types.js';

const contactSchema = z.object({
  fullName: z.string(),
  contactLine: z.string(),
});

const contactRules = [rule.regex('fullName', /^([A-Z][a-z]+\s+[A-Z][a-z]+)/, 0.95)];

const content =
  'Ada Lovelace - reachable at ada@example.com or +32 470 12 34 56 for inquiries.';

const echoProvider: LlmProvider = {
  async complete(request) {
    const tokens = (request.userContent.match(/<(EMAIL|PHONE)_\d+>/g) ?? []).join(' or ');
    return {
      values: {
        contactLine: `Reach Ada at ${tokens}`,
      },
    };
  },
};

type Stash = { emails: string[]; phones: string[] };

function redact(text: string, stash: Stash): string {
  return text
    .replace(/[\w.+-]+@[\w.-]+/g, (match) => {
      stash.emails.push(match);
      return `<EMAIL_${stash.emails.length - 1}>`;
    })
    .replace(/\+?\d[\d\s().-]{6,}\d/g, (match) => {
      stash.phones.push(match);
      return `<PHONE_${stash.phones.length - 1}>`;
    });
}

function restore(value: unknown, stash: Stash): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  return value
    .replace(/<EMAIL_(\d+)>/g, (_, i) => stash.emails[Number(i)] ?? `<EMAIL_${i}>`)
    .replace(/<PHONE_(\d+)>/g, (_, i) => stash.phones[Number(i)] ?? `<PHONE_${i}>`);
}

async function main() {
  const extractor = createExtractor({
    schema: contactSchema,
    rules: contactRules,
    llm: {
      provider: echoProvider,
      transformRequest: (request) => {
        const stash: Stash = { emails: [], phones: [] };
        return {
          ...request,
          userContent: redact(request.userContent, stash),
          knownValues: { ...request.knownValues, _pii: stash },
        };
      },
      transformResponse: (result, request) => {
        const stash = (request.knownValues._pii as Stash) ?? { emails: [], phones: [] };
        const values = Object.fromEntries(
          Object.entries(result.values).map(([k, v]) => [k, restore(v, stash)]),
        );
        return { ...result, values };
      },
    },
  });

  const result = await extractor.extract(content);

  console.log('── data ─────────────────────────────────────');
  console.dir(result.data, { depth: null });
  console.log('\n── confidence ───────────────────────────────');
  console.dir(result.confidence, { depth: null });
}

main().catch((error) => {
  console.error('pii-redaction example failed:', error);
  process.exit(1);
});
