/**
 * Text indexing utilities for local lexical retrieval
 * Industry-agnostic text normalization and tokenization
 */

/**
 * Normalize text: lowercase, remove punctuation except hyphen/slash, collapse whitespace
 */
export function normalizeText(str: string | null | undefined): string {
  if (!str || typeof str !== "string") return "";
  
  return str
    .toLowerCase()
    // Remove punctuation except hyphen, slash, apostrophe
    .replace(/[^\w\s\-\/']/g, " ")
    // Collapse whitespace
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Common stopwords to filter out
 */
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "of", "with", "by",
  "from", "as", "is", "was", "are", "were", "been", "be", "have", "has", "had", "do", "does", "did",
  "will", "would", "could", "should", "may", "might", "must", "can", "this", "that", "these", "those",
  "i", "you", "he", "she", "it", "we", "they", "me", "him", "her", "us", "them",
  "what", "which", "who", "whom", "where", "when", "why", "how", "if", "then", "else",
  "about", "above", "after", "before", "below", "between", "during", "through", "under", "over",
  "up", "down", "out", "off", "away", "back", "here", "there",
  "some", "any", "all", "both", "each", "every", "few", "many", "most", "other", "such",
  "no", "not", "none", "nothing", "nobody", "nowhere", "never", "neither", "nor",
  "into", "onto", "within", "without"
]);

/**
 * Tokenize text: split into tokens, drop tokens length<2, drop stopwords
 */
export function tokenize(text: string): string[] {
  if (!text) return [];
  
  const normalized = normalizeText(text);
  const tokens = normalized
    .split(/\s+/)
    .filter(token => token.length >= 2 && !STOPWORDS.has(token));
  
  return tokens;
}

/**
 * Strip HTML tags and decode entities from product description
 */
export function cleanDescription(html: string | null | undefined): string {
  if (!html || typeof html !== "string") return "";
  
  // Basic HTML tag removal
  let cleaned = html
    .replace(/<[^>]+>/g, " ") // Remove HTML tags
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/");
  
  // Decode common HTML entities (basic set)
  cleaned = cleaned
    .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  
  // Collapse whitespace
  cleaned = cleaned.replace(/\s+/g, " ").trim();
  
  return cleaned;
}

/**
 * Build search text from product data (normalized concatenation)
 */
export function buildSearchText(product: {
  title?: string | null;
  productType?: string | null;
  vendor?: string | null;
  tags?: string[];
  optionValues?: Record<string, string[]>;
  sizes?: string[];
  colors?: string[];
  materials?: string[];
  desc1000?: string;
}): string {
  const parts: string[] = [];
  
  if (product.title) parts.push(product.title);
  if (product.productType) parts.push(product.productType);
  if (product.vendor) parts.push(product.vendor);
  
  if (product.tags && product.tags.length > 0) {
    parts.push(product.tags.join(" "));
  }
  
  if (product.optionValues) {
    for (const [key, values] of Object.entries(product.optionValues)) {
      parts.push(key);
      if (Array.isArray(values)) {
        parts.push(values.join(" "));
      }
    }
  }
  
  if (product.sizes && product.sizes.length > 0) {
    parts.push(product.sizes.join(" "));
  }
  
  if (product.colors && product.colors.length > 0) {
    parts.push(product.colors.join(" "));
  }
  
  if (product.materials && product.materials.length > 0) {
    parts.push(product.materials.join(" "));
  }
  
  if (product.desc1000) {
    parts.push(product.desc1000);
  }
  
  return parts.join(" ").trim();
}

/**
 * Calculate BM25 score
 * Formula: IDF(qi) * (f(qi, D) * (k1 + 1)) / (f(qi, D) + k1 * (1 - b + b * |D| / avgdl))
 */
export function bm25Score(
  queryTokens: string[],
  docTokens: string[],
  docTokenFreq: Map<string, number>,
  docLen: number,
  avgDocLen: number,
  idf: Map<string, number>,
  k1: number = 1.2,
  b: number = 0.75
): number {
  let score = 0;
  
  for (const token of queryTokens) {
    const freq = docTokenFreq.get(token) || 0;
    if (freq === 0) continue;
    
    const idfValue = idf.get(token) || 0;
    if (idfValue === 0) continue;
    
    const numerator = freq * (k1 + 1);
    const denominator = freq + k1 * (1 - b + b * (docLen / avgDocLen));
    score += idfValue * (numerator / denominator);
  }
  
  return score;
}

/**
 * Calculate IDF (Inverse Document Frequency) for tokens across corpus
 * IDF(t) = log(N / df(t)) where N = total docs, df(t) = docs containing t
 */
export function calculateIDF(
  allDocs: Array<{ tokens: string[] }>
): Map<string, number> {
  const N = allDocs.length;
  if (N === 0) return new Map();
  
  // Document frequency: count how many docs contain each token
  const df = new Map<string, number>();
  
  for (const doc of allDocs) {
    const uniqueTokens = new Set(doc.tokens);
    for (const token of uniqueTokens) {
      df.set(token, (df.get(token) || 0) + 1);
    }
  }
  
  // Calculate IDF: log(N / df(t))
  const idf = new Map<string, number>();
  for (const [token, docFreq] of df.entries()) {
    if (docFreq > 0) {
      idf.set(token, Math.log(N / docFreq));
    }
  }
  
  return idf;
}

