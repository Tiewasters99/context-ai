// Which migrations actually reached prod? Probe every table declared by a
// migration file, plus the columns added by column-only migrations.
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync('C:/Users/equai/context-ai/.env', 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
    }),
);
const URL_ = env.VITE_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: KEY, authorization: `Bearer ${KEY}` };

const TABLES = `001|profiles 001|clientspaces 001|serverspaces 001|serverspace_members 001|matterspaces
001|content_items 001|tags 001|content_tags 001|cross_references 002|documents 002|passages
003|connector_tokens 013|authorities 013|authority_propositions 013|authority_editorial_notes
013|matter_authorities 013|authority_verifications 015|cite_check_runs 016|matterspace_members
017|matter_comments 019|meetings 019|meeting_chunks 019|meeting_messages 020|document_annotations
025|matter_events 026|connections 030|productions 030|production_items 030|document_tag_defs
030|document_tags 030|bates_registry 030|privilege_log_entries 030|deliveries 030|processing_jobs
031|orchestrator_feedback 033|mediation_cases 033|mediation_parties 033|mediation_date_proposals
033|mediation_messages 033|mediation_offers 034|argument_prep_sessions 034|argument_prep_messages
036|bucketizer_nodes 036|bucketizer_classifications 037|student_hub_sessions 037|student_hub_messages
039|student_hub_texts 041|student_hub_groups 041|student_hub_group_members 041|student_hub_group_messages
042|matter_state 042|matter_state_events 048|annotation_links`
  .split(/\s+/)
  .filter(Boolean)
  .map((s) => s.split('|'));

// Column-only migrations: (migration, table, column)
const COLUMNS = [
  ['021', 'matter_comments', 'attachment_document_ids'],
  ['028', 'documents', 'cover_url'],
  ['035', 'argument_prep_sessions', 'mode'],
  ['038', 'student_hub_texts', 'scan_pages'],
  ['043', 'matter_state', 'waiting_on'],
  ['044', 'processing_jobs', 'attempts'],
  ['048', 'document_annotations', 'visibility'],
];

const missing = [];
for (const [mig, t] of TABLES) {
  const r = await fetch(`${URL_}/rest/v1/${t}?select=*&limit=1`, { headers: H });
  if (r.status !== 200 && r.status !== 206) {
    missing.push([mig, t]);
    console.log(`MISSING TABLE   ${mig}  ${t}`);
  }
}
console.log(missing.length ? '' : 'All declared tables present.');

for (const [mig, t, c] of COLUMNS) {
  const r = await fetch(`${URL_}/rest/v1/${t}?select=${c}&limit=1`, { headers: H });
  const ok = r.status === 200 || r.status === 206;
  if (!ok) {
    const body = (await r.text()).slice(0, 90).replace(/\s+/g, ' ');
    console.log(`MISSING COLUMN  ${mig}  ${t}.${c}   ${body}`);
  }
}
console.log('\ndone');
