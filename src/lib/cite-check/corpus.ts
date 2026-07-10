// Load an already-ingested Contextspaces document as cite-check input.
//
// The corpus stores documents as ordered `passages` rows; a cite-check run
// wants one plain-text string. Concatenating summary_level=0 passages in
// sequence order reconstructs the document faithfully enough for citation
// extraction (the LLM extractor reports its own `location` snippets, so we
// don't need to preserve page coordinates in the input).

import { supabase } from '@/lib/supabase';

export interface CorpusDocumentText {
  documentId: string;
  title: string;
  text: string;
  passageCount: number;
}

export async function loadCorpusDocumentText(documentId: string): Promise<CorpusDocumentText> {
  const { data: doc, error: docErr } = await supabase
    .from('documents')
    .select('id, title, source_filename, processing_status')
    .eq('id', documentId)
    .maybeSingle();
  if (docErr || !doc) throw new Error(`document lookup: ${docErr?.message ?? 'not found'}`);
  if (doc.processing_status !== 'ready') {
    throw new Error(`"${doc.title}" is not fully ingested yet (status: ${doc.processing_status}).`);
  }

  // Page past PostgREST's 1000-row cap for long documents.
  const parts: string[] = [];
  let from = 0;
  let count = 0;
  for (;;) {
    const { data, error } = await supabase
      .from('passages')
      .select('text, sequence_number')
      .eq('document_id', documentId)
      .eq('summary_level', 0)
      .order('sequence_number', { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(`load passages: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const p of data) if (p.text) parts.push(p.text);
    count += data.length;
    if (data.length < 1000) break;
    from += 1000;
  }
  if (parts.length === 0) {
    throw new Error(`"${doc.title}" has no indexed text to check.`);
  }

  return {
    documentId: doc.id,
    title: doc.title || doc.source_filename || 'Untitled document',
    text: parts.join('\n\n'),
    passageCount: count,
  };
}
