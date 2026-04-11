export interface GenerateOptions {
  model: string;
  instruction: string;
  contextFiles: { name: string; content: string }[];
  onChunk: (text: string) => void;
  onDone: () => void;
  onError: (error: string) => void;
  signal?: AbortSignal;
}

const MODEL_MAP: Record<string, string> = {
  opus: 'claude-opus-4-6-20250415',
  sonnet: 'claude-sonnet-4-6-20250514',
};

export async function generateWithClaude({
  model,
  instruction,
  contextFiles,
  onChunk,
  onDone,
  onError,
  signal,
}: GenerateOptions) {
  const modelId = MODEL_MAP[model] ?? MODEL_MAP.sonnet;

  // Build the user message with context
  let userMessage = '';
  if (contextFiles.length > 0) {
    userMessage += 'Here are the context documents:\n\n';
    for (const file of contextFiles) {
      userMessage += `--- ${file.name} ---\n${file.content}\n\n`;
    }
    userMessage += '---\n\n';
  }
  userMessage += instruction;

  const body = {
    model: modelId,
    max_tokens: 4096,
    stream: true,
    messages: [{ role: 'user', content: userMessage }],
    system: 'You are an AI assistant inside The Vault, a secure document workspace. The user may provide context documents and an instruction. Follow the instruction precisely, using the provided documents as reference. Produce professional, well-formatted output.',
  };

  let res: Response;
  try {
    res = await fetch('/api/claude', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (signal?.aborted) return;
    onError('Network error — is the dev server running?');
    return;
  }

  if (!res.ok) {
    let detail = `API error (${res.status})`;
    try {
      const errBody = await res.json();
      if (errBody.error?.message) detail = errBody.error.message;
      else if (typeof errBody.error === 'string') detail = errBody.error;
    } catch { /* use default */ }
    onError(detail);
    return;
  }

  // Parse SSE stream
  const reader = res.body?.getReader();
  if (!reader) { onError('No response body'); return; }

  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;

      try {
        const event = JSON.parse(data);
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          onChunk(event.delta.text);
        } else if (event.type === 'message_stop') {
          // Stream complete
        } else if (event.type === 'error') {
          onError(event.error?.message ?? 'Stream error');
          return;
        }
      } catch { /* skip non-JSON lines */ }
    }
  }

  onDone();
}
