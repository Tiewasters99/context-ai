// SecureChat — the sealed personal room ("My SecureSpace").
//
// The room is an ordinary matterspace born sealed (ai_tier 'B' at INSERT),
// so every existing enforcement applies to it for free: the /api/llm gate,
// the sealed pen, the ai_sessions work-product ledger, connector
// invisibility, the seal-pipes holds. SecureChat is not a parallel chat
// system — it is the Assistant pointed at a room whose walls already exist.
//
// Why a matter and not a free-floating chat: United States v. Heppner
// (S.D.N.Y. 2026) handed a defendant's consumer-AI chats to the government
// on two grounds — no lawyer in the conversation, and provider terms that
// allowed logging, training and disclosure. The sealed room answers the
// second ground structurally (zero retention, no training, our own
// processing path, provable) and keeps the chat INSIDE a matter so
// counsel-directed use can answer the first. Find-or-create shape lifted
// from src/lib/student-hub-export.ts.

import { supabase } from '@/lib/supabase';

export const SECURECHAT_MATTER_NAME = 'My SecureSpace';

export async function ensureMySecureSpace(
  serverspaceId: string,
): Promise<{ id: string; name: string }> {
  const { data: existing, error: findErr } = await supabase
    .from('matterspaces')
    .select('id, name')
    .eq('serverspace_id', serverspaceId)
    .eq('name', SECURECHAT_MATTER_NAME)
    .is('parent_matterspace_id', null)
    .limit(1)
    .maybeSingle();
  if (findErr) throw new Error(findErr.message);
  if (existing) return existing;

  // short_code is globally unique (it is the MCP handle) — retry with a
  // suffix on collision. The room is sealed at birth, so it never appears
  // to connectors regardless; the code exists because the column wants one.
  for (let n = 0; n < 5; n++) {
    const short_code = n === 0 ? 'my-securespace' : `my-securespace-${n + 1}`;
    const { data: created, error: insErr } = await supabase
      .from('matterspaces')
      .insert({
        serverspace_id: serverspaceId,
        parent_matterspace_id: null,
        name: SECURECHAT_MATTER_NAME,
        short_code,
        ai_tier: 'B' as const,
      })
      .select('id, name')
      .single();
    if (!insErr) return created;
    if (!/duplicate|unique/i.test(insErr.message)) throw new Error(insErr.message);
  }
  throw new Error('Could not find a free short code for My SecureSpace.');
}
