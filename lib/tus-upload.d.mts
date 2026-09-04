// Types for lib/tus-upload.mjs — the browser bundle imports that module
// directly (src/lib/vault-persist.ts, src/lib/discovery.ts) so the Vault's
// resumable uploads and the Node smoke test share one implementation.

export const TUS_VERSION: string;
export const TUS_CHUNK_BYTES: number;
export const TUS_URL_TTL_MS: number;
export const RESUMABLE_MIN_BYTES: number;

export function shouldUploadResumable(sizeBytes: number | null | undefined): boolean;
export function encodeUploadMetadata(obj: Record<string, string | number | null | undefined>): string;
export function tusFingerprint(args: { bucket: string; objectName: string; size: number; lastModified?: number }): string;

export interface ResumeStore {
  get(key: string): string | null;
  set(key: string, url: string): void;
  delete(key: string): void;
}
export function memoryResumeStore(): ResumeStore;
export function storageResumeStore(storage: Storage | null | undefined): ResumeStore;

export interface UploadProgress {
  sent: number;
  total: number;
  pct: number;
}

export interface UploadResumableArgs {
  supabaseUrl: string;
  token: string;
  apikey?: string | null;
  bucket: string;
  objectName: string;
  blob: Blob;
  contentType?: string;
  cacheControl?: string;
  upsert?: boolean;
  lastModified?: number;
  onProgress?: (p: UploadProgress) => void;
  resumeStore?: ResumeStore;
  signal?: AbortSignal | null;
  fetchImpl?: typeof fetch;
  chunkBytes?: number;
  maxRetries?: number;
}

export function uploadResumable(args: UploadResumableArgs): Promise<{ uploadUrl: string; resumedFrom: number; size: number }>;
