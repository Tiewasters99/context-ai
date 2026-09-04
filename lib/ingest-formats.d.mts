// Types for lib/ingest-formats.mjs — the browser bundle imports that module
// directly (src/lib/vault-persist.ts) so the Vault's pre-upload checks share
// one definition with the Node pipeline.

export const SUPPORTED_EXTENSIONS: string[];
export const IMAGE_EXTENSIONS: string[];
export const OCRABLE_IMAGE_EXTENSIONS: string[];
export const AUDIO_EXTENSIONS: string[];
export const VIDEO_EXTENSIONS: string[];
export const MEDIA_EXTENSIONS: string[];
export const PLAIN_TEXT_EXTENSIONS: string[];
export const BINARY_ASSET_EXTENSIONS: string[];
export const ACCEPTED_EXTENSIONS: string[];

export const VAULT_MAX_BYTES: number;

export type TextStatus =
  | 'image_only'
  | 'no_text'
  | 'portfolio'
  | 'media_no_transcript'
  | 'binary_stored'
  | 'unsupported';

export const TEXT_STATUS: Readonly<{
  IMAGE_ONLY: 'image_only';
  NO_TEXT: 'no_text';
  PORTFOLIO: 'portfolio';
  MEDIA_NO_TRANSCRIPT: 'media_no_transcript';
  BINARY_STORED: 'binary_stored';
  UNSUPPORTED: 'unsupported';
}>;

export function describeTextStatus(status: string | null | undefined): { label: string; detail: string };

export function extOf(name: string | null | undefined): string;
export function formatBytes(n: number | null | undefined): string;
export const SUPPORTED_TYPES_SUMMARY: string;

export interface UploadRefusal {
  code: 'too_large' | 'unsupported';
  message: string;
}
export function checkUpload(file: { name: string; size: number }): UploadRefusal | null;
