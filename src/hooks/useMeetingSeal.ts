import { useQuery } from '@tanstack/react-query';
import { isSealedMatter } from '@/lib/vault-object';

export const SEALED_MEETING_NOTICE = 'This matter is sealed. Live transcription and Orchestrator flagging are off here, because neither runs inside the seal yet. You can still keep notes in this meeting.';

export function useMeetingSeal(matterId: string | null | undefined) {
  // The existing RPC walks the matter's ancestry, including inherited B/C.
  // Unknown seals stay closed; an explicitly unlinked meeting stays open.
  const query = useQuery({
    queryKey: ['meeting-seal', matterId],
    queryFn: () => isSealedMatter(matterId ?? null),
    enabled: matterId !== undefined,
  });
  const sealed = matterId === null ? false : query.data;
  const notice = sealed === true ? SEALED_MEETING_NOTICE
    : sealed === false ? null
    : query.isPending ? 'Checking this matter’s seal before enabling live transcription and flagging.'
    : 'This matter’s seal could not be checked. Live transcription and flagging are off. Reopen the meeting to try again; you can still keep notes.';
  return { sealed, notice, liveAllowed: sealed === false };
}
