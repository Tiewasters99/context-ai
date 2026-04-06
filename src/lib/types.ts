// Core enums
export type SpaceType = 'clientspace' | 'serverspace' | 'matterspace';
export type ContentType = 'page' | 'list' | 'database' | 'document';
export type AssistantMode = 'blind' | 'observer' | 'collaborative';
export type PricingTier = 'free' | 'pro' | 'max';
export type MemberRole = 'owner' | 'admin' | 'member' | 'viewer';

// Entities
export interface Profile {
  id: string;
  email: string;
  display_name: string;
  avatar_url?: string;
  pricing_tier: PricingTier;
  assistant_mode: AssistantMode;
  created_at: string;
  updated_at: string;
}

export interface Clientspace {
  id: string;
  user_id: string;
  name: string;
  cover_url?: string;
  created_at: string;
  updated_at: string;
}

export interface Serverspace {
  id: string;
  clientspace_id: string;
  name: string;
  description?: string;
  cover_url?: string;
  icon?: string;
  members_count?: number;
  created_at: string;
  updated_at: string;
}

export interface ServerspaceMember {
  id: string;
  serverspace_id: string;
  user_id: string;
  role: MemberRole;
  display_name?: string;
  avatar_url?: string;
  joined_at: string;
}

export interface Matterspace {
  id: string;
  serverspace_id: string;
  name: string;
  description?: string;
  cover_url?: string;
  icon?: string;
  created_at: string;
  updated_at: string;
}

export interface Tag {
  id: string;
  name: string;
  color: string;
}

export interface ContentItem {
  id: string;
  parent_id?: string;
  space_id: string;
  space_type: SpaceType;
  content_type: ContentType;
  title: string;
  content?: unknown;
  icon?: string;
  cover_url?: string;
  is_locked: boolean;
  locked_by?: string;
  tags: Tag[];
  position: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

// Navigation
export interface BreadcrumbItem {
  id: string;
  label: string;
  type: SpaceType | ContentType | 'dashboard';
  path: string;
}

// Chat
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}
