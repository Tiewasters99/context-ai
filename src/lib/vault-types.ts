export interface VaultFile {
  id: string;
  name: string;
  path: string;
  size: string;
  sizeBytes: number;
  type: string;
  file: File;
  status: 'uploading' | 'indexing' | 'indexed' | 'error';
  /** Extracted text content, available after indexing */
  textContent?: string;
}
