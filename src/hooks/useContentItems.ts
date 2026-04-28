// React Query wrappers around content_items. One cache key per
// (space_id, content_type) tuple — Pages, Lists, and Tables in a
// given matter each have their own list. Matterspace-scoped helpers
// are the common case; serverspace/clientspace are supported via the
// generic SpaceRef.

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';

export type ContentType = 'page' | 'list' | 'database' | 'document';
export type SpaceType = 'matterspace' | 'serverspace' | 'clientspace';

export interface SpaceRef {
  spaceId: string;
  spaceType: SpaceType;
}

export interface ContentItemSummary {
  id: string;
  title: string;
  content_type: ContentType;
  is_locked: boolean;
  position: number;
  updated_at: string;
}

export interface ContentItemFull extends ContentItemSummary {
  content: Record<string, unknown>;
  space_id: string;
  space_type: SpaceType;
  parent_id: string | null;
  icon: string | null;
  cover_url: string | null;
  locked_by: string | null;
  created_by: string;
  created_at: string;
}

const listKey = (space: SpaceRef, contentType: ContentType) =>
  ['content_items', space.spaceType, space.spaceId, contentType] as const;

const itemKey = (id: string) => ['content_item', id] as const;


export function useContentItems(space: SpaceRef | null, contentType: ContentType) {
  return useQuery({
    queryKey: space ? listKey(space, contentType) : ['content_items', 'noop'],
    enabled: !!space,
    queryFn: async (): Promise<ContentItemSummary[]> => {
      if (!space) return [];
      const { data, error } = await supabase
        .from('content_items')
        .select('id, title, content_type, is_locked, position, updated_at')
        .eq('space_id', space.spaceId)
        .eq('space_type', space.spaceType)
        .eq('content_type', contentType)
        .order('position', { ascending: true })
        .order('created_at', { ascending: true });
      if (error) throw new Error(`content_items: ${error.message}`);
      return (data ?? []) as ContentItemSummary[];
    },
    staleTime: 15_000,
  });
}


export function useContentItem(id: string | undefined) {
  return useQuery({
    queryKey: id ? itemKey(id) : ['content_item', 'noop'],
    enabled: !!id,
    queryFn: async (): Promise<ContentItemFull | null> => {
      if (!id) return null;
      const { data, error } = await supabase
        .from('content_items')
        .select('*')
        .eq('id', id)
        .maybeSingle();
      if (error) throw new Error(`content_item: ${error.message}`);
      return (data ?? null) as ContentItemFull | null;
    },
  });
}


// Imperative helpers — components call these for mutations and then
// invalidate the relevant cache keys. Keeping them outside hooks lets
// us call them from event handlers without dancing around React rules.

export async function createContentItem(params: {
  space: SpaceRef;
  contentType: ContentType;
  title?: string;
  content?: Record<string, unknown>;
}): Promise<ContentItemFull> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData.user?.id;
  if (!userId) throw new Error('Not signed in');
  const { data, error } = await supabase
    .from('content_items')
    .insert({
      space_id: params.space.spaceId,
      space_type: params.space.spaceType,
      content_type: params.contentType,
      title: params.title ?? defaultTitle(params.contentType),
      content: params.content ?? {},
      created_by: userId,
    })
    .select('*')
    .single();
  if (error) throw new Error(`create ${params.contentType}: ${error.message}`);
  return data as ContentItemFull;
}

export async function updateContentItem(
  id: string,
  patch: Partial<Pick<ContentItemFull, 'title' | 'content' | 'is_locked' | 'icon' | 'cover_url'>>,
): Promise<void> {
  const { error } = await supabase
    .from('content_items')
    .update(patch)
    .eq('id', id);
  if (error) throw new Error(`update content_item: ${error.message}`);
}

export async function deleteContentItem(id: string): Promise<void> {
  const { error } = await supabase
    .from('content_items')
    .delete()
    .eq('id', id);
  if (error) throw new Error(`delete content_item: ${error.message}`);
}


export function useContentInvalidate() {
  const qc = useQueryClient();
  return {
    invalidateList(space: SpaceRef, contentType: ContentType) {
      qc.invalidateQueries({ queryKey: listKey(space, contentType) });
    },
    invalidateItem(id: string) {
      qc.invalidateQueries({ queryKey: itemKey(id) });
    },
  };
}


function defaultTitle(contentType: ContentType): string {
  switch (contentType) {
    case 'page':     return 'Untitled Page';
    case 'list':     return 'Untitled List';
    case 'database': return 'Untitled Table';
    case 'document': return 'Untitled Document';
  }
}
