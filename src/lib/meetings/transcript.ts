import type { TranscriptChunk } from "./deepgram";

export type TranscriptLine = {
  id: string;
  text: string;
  speaker: number | null;
  start: number;
  end: number;
};

export type TranscriptState = {
  finals: TranscriptLine[];
  interim: string;
};

export const emptyTranscript: TranscriptState = { finals: [], interim: "" };

export function applyChunk(
  state: TranscriptState,
  chunk: TranscriptChunk,
): TranscriptState {
  if (!chunk.isFinal) {
    return { ...state, interim: chunk.text };
  }
  const line: TranscriptLine = {
    id: `${chunk.start.toFixed(3)}-${state.finals.length}`,
    text: chunk.text,
    speaker: chunk.speaker,
    start: chunk.start,
    end: chunk.end,
  };
  const last = state.finals[state.finals.length - 1];
  if (last && last.speaker === line.speaker && line.start - last.end < 1.5) {
    const merged: TranscriptLine = {
      ...last,
      text: `${last.text} ${line.text}`.trim(),
      end: line.end,
    };
    return {
      finals: [...state.finals.slice(0, -1), merged],
      interim: "",
    };
  }
  return {
    finals: [...state.finals, line],
    interim: "",
  };
}

export function renderTranscriptForClaude(state: TranscriptState): string {
  const parts = state.finals.map((line) => {
    const who = line.speaker == null ? "Speaker" : `Speaker ${line.speaker}`;
    return `${who}: ${line.text}`;
  });
  if (state.interim) parts.push(`(...${state.interim})`);
  return parts.join("\n");
}
