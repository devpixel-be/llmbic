import { z } from 'zod';
import { rule } from '../../src/rules.js';
import type { ExtractionRule } from '../../src/types/rule.types.js';

/**
 * Zod schema for an `Order` document - spans string, number, enum and nullable
 * so the end-to-end test exercises every Zod kind supported by `prompt.build`.
 */
export const orderSchema = z.object({
  orderNumber: z.string(),
  issuedOn: z.string(),
  currency: z.enum(['EUR', 'USD', 'GBP']),
  total: z.number(),
  customer: z.string(),
  notes: z.string().nullable(),
});

/**
 * Deterministic rules covering the four fields that are trivially regex-able on
 * the markdown fixture. `customer` and `notes` are intentionally left for the
 * LLM fallback so the full pipeline is exercised.
 */
export const orderRules: ExtractionRule[] = [
  rule.regex('orderNumber', /Order\s+#([A-Z0-9-]+)/, 0.95),
  rule.regex('issuedOn', /Issued on:\s*(\d{4}-\d{2}-\d{2})/, 0.9),
  rule.regex('currency', /Currency:\s*(EUR|USD|GBP)/, 0.9),
  rule.regex('total', /Total:\s*[€$£]\s*([\d.]+)/, 0.85, (match) => Number(match[1])),
];

/**
 * Realistic markdown for an order document. The rules above pick up four fields
 * out of the box; `customer` and `notes` require the LLM fallback.
 */
export const orderMarkdown = `
# Order #ORD-2026-0412

Issued on: 2026-03-14
Currency: EUR

| Item | Qty | Price |
|---|---|---|
| Graphite pencil | 12 | € 0.90 |
| Sketchbook A5   | 3  | € 6.50 |

Total: € 30.30

Billed to Alice Durand, Studio Orange.
Please deliver before Friday; leave the parcel at the reception if we are out.
`.trim();

/**
 * Values the LLM mock returns for the two fields missing after rules.
 */
export const orderLlmValues = {
  customer: 'Alice Durand',
  notes: 'Deliver before Friday; leave at reception if nobody is in.',
};
