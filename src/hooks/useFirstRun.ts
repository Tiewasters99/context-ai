// The data behind the Dashboard's first-run docket.
//
// Every rule this hook applies is a function in
// src/components/firstrun/first-run.ts, which has no React in it and is
// asserted by scripts/_test-first-run.mjs. What is left here is the wiring:
// which queries to run, when NOT to run them, and holding the one in-flight
// flag that stops a double-click reaching the database twice.
//
// Nothing here runs for an account that will not see the docket. The facts
// query is `enabled: show`, so Eden's own workshop dashboard — and any
// account that has dismissed the list — issues exactly zero extra requests on
// every load of the home screen.

import { useCallback, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import { useServerspaces, useServerspacesRefresh } from '@/hooks/useServerspaces';
import { defaultCoverFor, loadCoreCovers } from '@/lib/covers';
import { FIRST_RUN_COPY } from '@/components/firstrun/copy';
import {
  COMPLETION_KINDS,
  createFirstServerspace,
  defaultWorkspaceName,
  hasAnyMatter,
  pickFirstMatter,
  pickFirstServerspace,
  readDismissed,
  shouldShowFirstRun,
  writeDismissed,
  type CreateOutcome,
  type DocketServerspace,
  type FirstRunClient,
  type FirstRunFacts,
  type FirstRunTarget,
} from '@/components/firstrun/first-run';

// Cast once, here, exactly as useMatterRecord.ts does for RecordClient.
const client = supabase as unknown as FirstRunClient;

/** localStorage, or null where the browser refuses to hand it over. */
function browserStore() {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** One `limit(1)` read. A row → true, no row → false, an error → null (unknown). */
async function peek(run: () => PromiseLike<{ data: unknown[] | null; error: unknown }>) {
  try {
    const { data, error } = await run();
    if (error) return null;
    return (data?.length ?? 0) > 0;
  } catch {
    return null;
  }
}

export interface FirstRunState {
  /** Render the docket at all. */
  show: boolean;
  facts: FirstRunFacts;
  /** Still reading the facts the ticks derive from. */
  factsLoading: boolean;
  /** The matter steps 3, 4 and 6 act on, or null while there is none. */
  target: FirstRunTarget | null;
  /** Where step 2 creates its matter. */
  firstServerspace: { id: string; name: string } | null;
  /** The name step 1 will use, shown in the line before the click. */
  workspaceName: string;
  creating: boolean;
  /** A sentence about the one thing that failed, or null. */
  error: string | null;
  createWorkspace: () => Promise<void>;
  clearError: () => void;
  dismiss: () => void;
}

export function useFirstRun(): FirstRunState {
  const { user, plan, planLoading } = useAuth();
  const { data: serverspaces = [], isLoading: serverspacesLoading } = useServerspaces();
  const refreshServerspaces = useServerspacesRefresh();
  const queryClient = useQueryClient();

  const userId = user?.id ?? null;
  const [dismissed, setDismissed] = useState(() => readDismissed(browserStore(), userId));
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Survives re-renders; the fresh read inside createFirstServerspace survives
  // a remount. Both, because neither alone covers a double-click.
  const inFlight = useRef(false);

  const show = shouldShowFirstRun({ plan, planLoading, serverspacesLoading, dismissed });

  const spaces = serverspaces as readonly DocketServerspace[];
  const hasServerspace = spaces.length > 0;
  const hasMatter = hasAnyMatter(spaces);

  // The three reads the serverspaces query cannot answer. Each is its own
  // question, each degrades to "unknown" on its own, and none of them runs
  // unless the docket is on screen.
  const { data: remote, isLoading: factsLoading } = useQuery({
    queryKey: ['first-run-facts', userId],
    enabled: show && !!userId,
    staleTime: 60_000,
    queryFn: async () => {
      const [document, completion, ledger, grant] = await Promise.all([
        peek(() => supabase.from('documents').select('id').limit(1)),
        peek(() => supabase.from('events').select('id').in('kind', COMPLETION_KINDS).limit(1)),
        peek(() => supabase.from('events').select('id').limit(1)),
        peek(() => supabase.from('oauth_grants').select('id').is('revoked_at', null).limit(1)),
      ]);
      return { document, completion, ledger, grant };
    },
  });

  const facts: FirstRunFacts = useMemo(
    () => ({
      hasServerspace,
      hasMatter,
      hasDocument: remote?.document ?? null,
      hasAssistantRun: remote?.completion ?? null,
      hasRecordEntry: remote?.ledger ?? null,
      hasAiConnection: remote?.grant ?? null,
    }),
    [hasServerspace, hasMatter, remote],
  );

  const target = useMemo(() => pickFirstMatter(spaces), [spaces]);
  const firstServerspace = useMemo(() => pickFirstServerspace(spaces), [spaces]);

  const workspaceName = useMemo(
    () =>
      defaultWorkspaceName(
        user?.user_metadata as Record<string, unknown> | undefined,
        user?.email,
        FIRST_RUN_COPY.workspaceFallbackName,
      ),
    [user?.user_metadata, user?.email],
  );

  const createWorkspace = useCallback(async () => {
    if (!userId || inFlight.current) return;
    inFlight.current = true;
    setCreating(true);
    setError(null);
    let outcome: CreateOutcome;
    try {
      // A cover the core set allows, chosen by a stable hash of the name so
      // the same account always opens on the same picture. A failed manifest
      // read gives null, and a missing cover must never stop the create.
      const core = await loadCoreCovers();
      const coverUrl = defaultCoverFor(workspaceName, core?.core ?? null);
      outcome = await createFirstServerspace(client, {
        userId,
        name: workspaceName,
        coverUrl,
      });
    } catch (err) {
      outcome = {
        ok: false,
        serverspaceId: null,
        created: false,
        reason: 'insert_failed',
        message: err instanceof Error ? err.message : null,
      };
    }
    inFlight.current = false;
    setCreating(false);
    if (!outcome.ok) {
      setError(
        outcome.reason === 'no_clientspace'
          ? FIRST_RUN_COPY.noClientspace
          : FIRST_RUN_COPY.errorPrefix + (outcome.message ?? 'the server gave no reason.'),
      );
      return;
    }
    await refreshServerspaces();
    await queryClient.invalidateQueries({ queryKey: ['first-run-facts', userId] });
  }, [userId, workspaceName, refreshServerspaces, queryClient]);

  const clearError = useCallback(() => setError(null), []);

  const dismiss = useCallback(() => {
    setDismissed(true);
    writeDismissed(browserStore(), userId);
  }, [userId]);

  return {
    show,
    facts,
    factsLoading: show && factsLoading,
    target,
    firstServerspace,
    workspaceName,
    creating,
    error,
    createWorkspace,
    clearError,
    dismiss,
  };
}
