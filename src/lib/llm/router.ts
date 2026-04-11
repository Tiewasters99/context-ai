import type { ModelConfig, RoutingDecision } from './types';

// Rough estimate: 1 token ≈ 4 characters for English text
const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function routeRequest(
  contextText: string,
  instruction: string,
  model: ModelConfig,
  providerId: string,
): RoutingDecision {
  const totalText = contextText + instruction;
  const estimatedTokens = estimateTokens(totalText);
  // Reserve tokens for the response
  const availableContext = model.contextWindow - (model.contextWindow > 500000 ? 8192 : 4096);

  if (estimatedTokens <= availableContext) {
    return {
      strategy: 'whole',
      model,
      provider: providerId as any,
      estimatedTokens,
      contextWindow: model.contextWindow,
      message: `Document fits within ${model.name}'s context window.`,
    };
  }

  return {
    strategy: 'chunked',
    model,
    provider: providerId as any,
    estimatedTokens,
    contextWindow: model.contextWindow,
    message: `Document is ~${Math.round(estimatedTokens / 1000)}K tokens — exceeds ${model.name}'s ${Math.round(model.contextWindow / 1000)}K window. Relevant sections will be extracted and sent.`,
  };
}

/** Split text into chunks that fit within a token budget, respecting paragraph boundaries */
export function chunkText(text: string, maxTokensPerChunk: number): string[] {
  const maxChars = maxTokensPerChunk * CHARS_PER_TOKEN;
  const paragraphs = text.split(/\n\n+/);
  const chunks: string[] = [];
  let current = '';

  for (const para of paragraphs) {
    if (current.length + para.length + 2 > maxChars) {
      if (current) chunks.push(current.trim());
      // If a single paragraph exceeds max, split by sentences
      if (para.length > maxChars) {
        const sentences = para.split(/(?<=[.!?])\s+/);
        current = '';
        for (const sentence of sentences) {
          if (current.length + sentence.length + 1 > maxChars) {
            if (current) chunks.push(current.trim());
            current = sentence;
          } else {
            current += (current ? ' ' : '') + sentence;
          }
        }
      } else {
        current = para;
      }
    } else {
      current += (current ? '\n\n' : '') + para;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  return chunks;
}

/** Simple keyword-based relevance scoring for chunks */
export function scoreChunks(chunks: string[], query: string): { chunk: string; score: number }[] {
  const queryWords = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);

  return chunks.map((chunk) => {
    const lower = chunk.toLowerCase();
    let score = 0;
    for (const word of queryWords) {
      const regex = new RegExp(word, 'gi');
      const matches = lower.match(regex);
      if (matches) score += matches.length;
    }
    return { chunk, score };
  }).sort((a, b) => b.score - a.score);
}

/** Select the most relevant chunks that fit within the token budget */
export function selectRelevantChunks(
  text: string,
  query: string,
  maxTokens: number,
): string {
  const chunkSize = Math.min(maxTokens / 3, 30000); // each chunk ≈ 1/3 of budget
  const chunks = chunkText(text, chunkSize);
  const scored = scoreChunks(chunks, query);

  let selectedText = '';
  let tokenCount = 0;

  for (const { chunk } of scored) {
    const chunkTokens = estimateTokens(chunk);
    if (tokenCount + chunkTokens > maxTokens) break;
    selectedText += (selectedText ? '\n\n---\n\n' : '') + chunk;
    tokenCount += chunkTokens;
  }

  return selectedText;
}
