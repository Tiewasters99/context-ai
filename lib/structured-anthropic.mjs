// Server/CLI-side structured output via Anthropic tool use. The Node-side
// counterpart of src/lib/llm's browser adapter layer: callers hand over
// prompts + a JSON schema and get the parsed object back — the provider wire
// shape lives only here (the same rule lib/ocr-gemini.mjs follows for OCR).

import Anthropic from '@anthropic-ai/sdk';

/**
 * @param {{
 *   apiKey: string,
 *   model: string,
 *   system: string,
 *   userContent: string,
 *   toolName: string,
 *   toolDescription: string,
 *   inputSchema: Record<string, unknown>,
 *   maxTokens?: number,
 * }} opts
 * @returns {Promise<unknown>} the tool input object the model produced
 */
export async function generateStructuredAnthropic(opts) {
  const client = new Anthropic({ apiKey: opts.apiKey });
  const msg = await client.messages.create(buildStructuredParams(opts));
  return extractStructuredOutput(msg);
}

/**
 * The Messages-API params for a structured-output request — shared by the
 * synchronous call above and the Batches API path (each batch request takes
 * the same params object).
 */
export function buildStructuredParams(opts) {
  return {
    model: opts.model,
    max_tokens: opts.maxTokens ?? 4096,
    system: opts.system,
    messages: [{ role: 'user', content: opts.userContent }],
    tools: [{
      name: opts.toolName,
      description: opts.toolDescription,
      input_schema: opts.inputSchema,
    }],
    tool_choice: { type: 'tool', name: opts.toolName },
  };
}

/** @param {{content: {type: string, input?: unknown}[]}} msg */
export function extractStructuredOutput(msg) {
  const block = msg.content.find((b) => b.type === 'tool_use');
  if (!block) throw new Error('Model did not return structured output.');
  return block.input;
}

/**
 * Submit a Message Batch (50% of synchronous pricing) and wait for it to
 * finish. Results arrive in arbitrary order — always key on custom_id.
 *
 * @param {{
 *   apiKey: string,
 *   entries: {customId: string, params: Record<string, unknown>}[],
 *   pollMs?: number,
 *   onProgress?: (batch: any) => void,
 * }} opts
 * @returns {Promise<{batchId: string, results: any[]}>}
 */
export async function runStructuredBatch(opts) {
  const client = new Anthropic({ apiKey: opts.apiKey });
  // Creation can die on a mid-upload connection cut ("400 terminated") with
  // the batch possibly created server-side anyway. On failure, look for a
  // just-created batch of the same size and adopt it before re-submitting —
  // a blind retry could double-classify 500 documents.
  let batch;
  for (let attempt = 0; !batch; attempt++) {
    try {
      batch = await client.messages.batches.create({
        requests: opts.entries.map((e) => ({ custom_id: e.customId, params: e.params })),
      });
    } catch (e) {
      const page = await client.messages.batches.list({ limit: 5 }).catch(() => null);
      const counts = (b) => Object.values(b.request_counts ?? {}).reduce((a, n) => a + (n || 0), 0);
      const recent = page?.data?.find((b) =>
        Date.now() - new Date(b.created_at).getTime() < 5 * 60_000 && counts(b) === opts.entries.length);
      if (recent) { batch = recent; break; }
      if (attempt >= 3) throw e;
      await new Promise((r) => setTimeout(r, (attempt + 1) * 20_000));
    }
  }
  // A failed status poll is harmless — the batch keeps processing server-side
  // regardless — so tolerate transient API/gateway errors (a Cloudflare 502
  // killed a Fleming run, 2026-07-22) and only give up after ~30 min of
  // consecutive failures.
  let pollFailures = 0;
  for (;;) {
    try {
      const b = await client.messages.batches.retrieve(batch.id);
      pollFailures = 0;
      opts.onProgress?.(b);
      if (b.processing_status === 'ended') break;
    } catch (e) {
      pollFailures += 1;
      opts.onProgress?.({ id: batch.id, processing_status: `poll error (${pollFailures}): ${e.message?.slice(0, 80)}`, request_counts: { processing: '?', succeeded: '?', errored: '?' } });
      if (pollFailures >= 30) throw e;
    }
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 60_000));
  }
  for (let attempt = 0; ; attempt++) {
    try {
      const results = [];
      for await (const result of await client.messages.batches.results(batch.id)) {
        results.push(result);
      }
      return { batchId: batch.id, results };
    } catch (e) {
      if (attempt >= 4) throw e;
      await new Promise((r) => setTimeout(r, (attempt + 1) * 15_000));
    }
  }
}
