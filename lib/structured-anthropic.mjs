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
  const msg = await client.messages.create({
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
  });
  const block = msg.content.find((b) => b.type === 'tool_use');
  if (!block) throw new Error('Model did not return structured output.');
  return block.input;
}
