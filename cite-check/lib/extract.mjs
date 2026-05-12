// Read a draft into plain text. Supports .docx and .md/.txt. The
// extracted text is what the citation extractor sees, so any markup
// (Word styles, headers/footers, comments) is dropped here.
import fs from 'node:fs/promises';
import path from 'node:path';

export async function readDraft(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.docx') {
    const mammoth = await import('mammoth');
    const buffer = await fs.readFile(filePath);
    const { value } = await mammoth.extractRawText({ buffer });
    return value;
  }
  if (ext === '.pdf') {
    const { default: pdfParse } = await import('pdf-parse/lib/pdf-parse.js');
    const buffer = await fs.readFile(filePath);
    const parsed = await pdfParse(buffer);
    return parsed.text || '';
  }
  if (ext === '.md' || ext === '.txt') {
    return fs.readFile(filePath, 'utf8');
  }
  throw new Error(`Unsupported draft format: ${ext}. Use .docx, .pdf, or .md/.txt.`);
}
