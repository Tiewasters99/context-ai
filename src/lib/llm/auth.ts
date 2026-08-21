// The /api/llm proxy is JWT-gated (the SecureSpace gate). Every call from
// the browser attaches the signed-in user's Supabase access token; the
// server verifies it and, for matter-bound requests, checks the matter's
// tier before any provider sees a word.

import { supabase } from '@/lib/supabase';

export async function llmAuthHeader(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { authorization: `Bearer ${token}` } : {};
}
