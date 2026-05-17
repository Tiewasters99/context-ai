import { supabase } from './supabase';

export type AnnotationColor = 'gold' | 'green' | 'pink' | 'blue';

export type FractionalRect = {
  x: number;
  y: number;
  w: number;
  h: number;
};

export type Annotation = {
  id: string;
  document_id: string;
  user_id: string;
  page: number;
  color: AnnotationColor;
  note: string | null;
  anchor_text: string | null;
  rects: FractionalRect[];
  created_at: string;
  updated_at: string;
};

export async function listAnnotations(documentId: string): Promise<Annotation[]> {
  const { data, error } = await supabase
    .from('document_annotations')
    .select(
      'id, document_id, user_id, page, color, note, anchor_text, rects, created_at, updated_at',
    )
    .eq('document_id', documentId)
    .order('created_at', { ascending: true });
  if (error) {
    console.warn('[annotations load] failed:', error.message);
    return [];
  }
  return (data ?? []) as Annotation[];
}

export async function createAnnotation(args: {
  documentId: string;
  page: number;
  color: AnnotationColor;
  rects: FractionalRect[];
  anchorText?: string | null;
  note?: string | null;
}): Promise<Annotation | null> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData.user?.id;
  if (!userId) return null;
  const { data, error } = await supabase
    .from('document_annotations')
    .insert({
      document_id: args.documentId,
      user_id: userId,
      page: args.page,
      color: args.color,
      rects: args.rects,
      anchor_text: args.anchorText ?? null,
      note: args.note ?? null,
    })
    .select()
    .single();
  if (error) {
    console.warn('[annotation insert] failed:', error.message);
    return null;
  }
  return data as Annotation;
}

export async function deleteAnnotation(id: string): Promise<boolean> {
  const { error } = await supabase
    .from('document_annotations')
    .delete()
    .eq('id', id);
  if (error) {
    console.warn('[annotation delete] failed:', error.message);
    return false;
  }
  return true;
}

export async function updateAnnotationNote(
  id: string,
  note: string | null,
): Promise<boolean> {
  const { error } = await supabase
    .from('document_annotations')
    .update({ note })
    .eq('id', id);
  if (error) {
    console.warn('[annotation update note] failed:', error.message);
    return false;
  }
  return true;
}
