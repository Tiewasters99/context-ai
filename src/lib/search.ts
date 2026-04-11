import type { VaultFile } from './vault-types';

export interface SearchResult {
  file: VaultFile;
  score: number;
  /** Best matching excerpt from the file */
  excerpt: string;
}

/**
 * Search all vault files by keyword relevance.
 * Extracts keywords from a natural language query,
 * scores each file, and returns ranked results.
 */
export function searchVaultFiles(
  files: VaultFile[],
  query: string,
  maxResults = 20,
): SearchResult[] {
  const keywords = extractKeywords(query);
  if (keywords.length === 0) return [];

  const results: SearchResult[] = [];

  for (const file of files) {
    if (!file.textContent || file.status !== 'indexed') continue;

    const lower = file.textContent.toLowerCase();
    const nameLower = file.name.toLowerCase();
    let score = 0;

    // Score by keyword matches in content
    for (const kw of keywords) {
      const regex = new RegExp(kw, 'gi');
      const contentMatches = lower.match(regex);
      const nameMatches = nameLower.match(regex);
      if (contentMatches) score += contentMatches.length;
      if (nameMatches) score += nameMatches.length * 10; // filename matches worth more
    }

    if (score > 0) {
      const excerpt = findBestExcerpt(file.textContent, keywords);
      results.push({ file, score, excerpt });
    }
  }

  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);
}

/**
 * Extract meaningful keywords from a natural language query.
 * Strips common stop words and instruction verbs.
 */
function extractKeywords(query: string): string[] {
  const stopWords = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
    'has', 'have', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'can', 'shall', 'this', 'that', 'these',
    'those', 'it', 'its', 'my', 'your', 'our', 'their', 'his', 'her',
    'all', 'any', 'each', 'every', 'both', 'few', 'more', 'most', 'some',
    'such', 'no', 'not', 'only', 'same', 'than', 'too', 'very',
    'find', 'search', 'look', 'get', 'show', 'list', 'give', 'tell',
    'write', 'draft', 'create', 'make', 'output', 'generate', 'produce',
    'then', 'also', 'just', 'about', 'up', 'out', 'if', 'when', 'where',
    'how', 'what', 'which', 'who', 'whom', 'why', 'so', 'as', 'into',
    'through', 'during', 'before', 'after', 'above', 'below', 'between',
    'recent', 'recently', 'dated', 'today', 'regarding', 'concerning',
    'please', 'using', 'based', 'explain', 'summarize', 'describe',
  ]);

  return query
    .toLowerCase()
    .replace(/[^\w\s'-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !stopWords.has(w));
}

/**
 * Find the best matching excerpt (a few sentences around the highest
 * concentration of keyword matches).
 */
function findBestExcerpt(text: string, keywords: string[], excerptLength = 300): string {
  const lower = text.toLowerCase();
  let bestStart = 0;
  let bestScore = 0;

  // Sliding window
  const windowSize = excerptLength;
  const step = Math.max(50, Math.floor(windowSize / 4));

  for (let i = 0; i < lower.length - windowSize; i += step) {
    const window = lower.slice(i, i + windowSize);
    let score = 0;
    for (const kw of keywords) {
      const matches = window.match(new RegExp(kw, 'gi'));
      if (matches) score += matches.length;
    }
    if (score > bestScore) {
      bestScore = score;
      bestStart = i;
    }
  }

  // Snap to word boundary
  const start = text.lastIndexOf(' ', bestStart) + 1;
  const end = text.indexOf(' ', bestStart + excerptLength) || bestStart + excerptLength;
  const excerpt = text.slice(start, end).trim();

  return excerpt ? `...${excerpt}...` : text.slice(0, excerptLength).trim() + '...';
}

/**
 * Auto-select files relevant to a query within a token budget.
 * Returns the files and their combined text.
 */
export function autoSelectFiles(
  files: VaultFile[],
  query: string,
  maxTokens: number,
): { selected: VaultFile[]; totalTokens: number } {
  const results = searchVaultFiles(files, query);
  const selected: VaultFile[] = [];
  let totalTokens = 0;

  for (const result of results) {
    const fileTokens = Math.ceil((result.file.textContent?.length ?? 0) / 4);
    if (totalTokens + fileTokens > maxTokens) {
      // If nothing selected yet, take at least partial content of the best match
      if (selected.length === 0) {
        selected.push(result.file);
        totalTokens += fileTokens;
      }
      break;
    }
    selected.push(result.file);
    totalTokens += fileTokens;
  }

  return { selected, totalTokens };
}
