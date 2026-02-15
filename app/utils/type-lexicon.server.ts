/**
 * Type Lexicon utilities for Primary Item-Type Anchor implementation
 * Industry-agnostic: works with any Shopify store
 */

/**
 * Normalizes a term for lexicon matching:
 * - Lowercase
 * - Trim whitespace
 * - Remove punctuation (keep spaces for multi-word phrases)
 */
export function normalizeTypeTerm(term: string): string {
  return term
    .toLowerCase()
    .trim()
    .replace(/[^\w\s]/g, "") // Remove punctuation, keep alphanumeric and spaces
    .replace(/\s+/g, " ") // Normalize whitespace
    .trim();
}

/**
 * Builds a Type Lexicon from Shopify catalog
 * Sources: productType (primary), tags (secondary), collections (optional)
 * Returns a Set of normalized type terms
 */
export function buildTypeLexicon(products: Array<{
  productType?: string | null;
  tags?: string[] | null;
  collections?: Array<{ title?: string } | string> | null;
}>): Set<string> {
  const lexicon = new Set<string>();
  
  for (const product of products) {
    // Primary: productType
    if (product.productType) {
      const normalized = normalizeTypeTerm(product.productType);
      if (normalized.length > 0) {
        lexicon.add(normalized);
      }
    }
    
    // Secondary: tags
    if (Array.isArray(product.tags)) {
      for (const tag of product.tags) {
        if (typeof tag === "string" && tag.trim().length > 0) {
          const normalized = normalizeTypeTerm(tag);
          if (normalized.length > 0) {
            lexicon.add(normalized);
          }
        }
      }
    }
    
    // Optional: collections
    if (Array.isArray(product.collections)) {
      for (const collection of product.collections) {
        let title: string | null = null;
        if (typeof collection === "string") {
          title = collection;
        } else if (collection && typeof collection === "object" && "title" in collection) {
          title = collection.title || null;
        }
        
        if (title && title.trim().length > 0) {
          const normalized = normalizeTypeTerm(title);
          if (normalized.length > 0) {
            lexicon.add(normalized);
          }
        }
      }
    }
  }
  
  return lexicon;
}

/**
 * Parses user text into type terms vs attribute terms
 * Type terms: tokens/phrases that match entries in the Type Lexicon
 * Attribute terms: everything else (color/material/style/size etc)
 */
export function parseTypeTermsVsAttributes(
  userText: string,
  typeLexicon: Set<string>
): {
  typeTerms: string[];
  attributeTerms: string[];
  typeTermMatches: Array<{ term: string; matchedLexiconEntry: string }>;
} {
  const typeTerms: string[] = [];
  const attributeTerms: string[] = [];
  const typeTermMatches: Array<{ term: string; matchedLexiconEntry: string }> = [];
  
  // Normalize user text
  const normalizedText = normalizeTypeTerm(userText);
  
  // Split into tokens (words and phrases)
  // Try multi-word phrases first (longest match), then single words
  const words = normalizedText.split(/\s+/);
  const matchedIndices = new Set<number>();
  
  // Check for multi-word phrases (2-4 words) first
  for (let phraseLength = 4; phraseLength >= 2; phraseLength--) {
    for (let i = 0; i <= words.length - phraseLength; i++) {
      // Skip if any word in this phrase is already matched
      let alreadyMatched = false;
      for (let j = i; j < i + phraseLength; j++) {
        if (matchedIndices.has(j)) {
          alreadyMatched = true;
          break;
        }
      }
      if (alreadyMatched) continue;
      
      const phrase = words.slice(i, i + phraseLength).join(" ");
      if (typeLexicon.has(phrase)) {
        typeTerms.push(phrase);
        typeTermMatches.push({ term: phrase, matchedLexiconEntry: phrase });
        // Mark all words in this phrase as matched
        for (let j = i; j < i + phraseLength; j++) {
          matchedIndices.add(j);
        }
      }
    }
  }
  
  // Check single words
  for (let i = 0; i < words.length; i++) {
    if (matchedIndices.has(i)) continue; // Already part of a matched phrase
    
    const word = words[i];
    if (word.length > 0 && typeLexicon.has(word)) {
      typeTerms.push(word);
      typeTermMatches.push({ term: word, matchedLexiconEntry: word });
      matchedIndices.add(i);
    }
  }
  
  // Everything else is an attribute term
  for (let i = 0; i < words.length; i++) {
    if (!matchedIndices.has(i)) {
      const word = words[i];
      if (word.length > 0) {
        attributeTerms.push(word);
      }
    }
  }
  
  return {
    typeTerms: Array.from(new Set(typeTerms)), // Deduplicate
    attributeTerms: Array.from(new Set(attributeTerms)), // Deduplicate
    typeTermMatches,
  };
}

/**
 * Selects the primary type anchor from candidate type terms
 * Returns the highest-confidence match (longest match, or first if equal length)
 * Returns null if no type terms found
 */
export function selectPrimaryTypeAnchor(
  typeTerms: string[],
  typeTermMatches: Array<{ term: string; matchedLexiconEntry: string }>
): string | null {
  if (typeTerms.length === 0) {
    return null;
  }
  
  // Prefer longest match (more specific)
  const sorted = [...typeTerms].sort((a, b) => {
    // Longer terms first
    if (b.length !== a.length) {
      return b.length - a.length;
    }
    // If equal length, prefer exact matches from lexicon
    return a.localeCompare(b);
  });
  
  return sorted[0];
}

/**
 * Checks if a product matches the primary type anchor
 * Matches against: productType, tags, collections
 */
export function productMatchesTypeAnchor(
  product: {
    productType?: string | null;
    tags?: string[] | null;
    collections?: Array<{ title?: string } | string> | null;
  },
  primaryTypeAnchor: string
): boolean {
  // Normalize anchor for comparison
  const normalizedAnchor = normalizeTypeTerm(primaryTypeAnchor);
  
  // Check productType (strongest match)
  if (product.productType) {
    const normalized = normalizeTypeTerm(product.productType);
    if (normalized === normalizedAnchor) {
      return true;
    }
  }
  
  // Check tags
  if (Array.isArray(product.tags)) {
    for (const tag of product.tags) {
      if (typeof tag === "string") {
        const normalized = normalizeTypeTerm(tag);
        if (normalized === normalizedAnchor) {
          return true;
        }
      }
    }
  }
  
  // Check collections
  if (Array.isArray(product.collections)) {
    for (const collection of product.collections) {
      let title: string | null = null;
      if (typeof collection === "string") {
        title = collection;
      } else if (collection && typeof collection === "object" && "title" in collection) {
        title = collection.title || null;
      }
      
      if (title) {
        const normalized = normalizeTypeTerm(title);
        if (normalized === normalizedAnchor) {
          return true;
        }
      }
    }
  }
  
  return false;
}

/**
 * Generates morphological variants and synonyms for a type anchor
 * Used for fallback widening within anchor family
 * Returns array of variant terms (including original)
 */
export function generateTypeAnchorVariants(
  primaryTypeAnchor: string,
  typeLexicon: Set<string>
): string[] {
  const variants = new Set<string>([primaryTypeAnchor]);
  
  // Simple morphological variants (industry-agnostic)
  const anchorLower = primaryTypeAnchor.toLowerCase();
  
  // Plural/singular variants (simple rules)
  if (anchorLower.endsWith("s") && anchorLower.length > 1) {
    const singular = anchorLower.slice(0, -1);
    if (typeLexicon.has(singular)) {
      variants.add(singular);
    }
  } else if (anchorLower.length > 1) {
    const plural = anchorLower + "s";
    if (typeLexicon.has(plural)) {
      variants.add(plural);
    }
  }
  
  // Check for similar terms in lexicon (fuzzy matching)
  // Find terms that share significant word overlap
  const anchorWords = anchorLower.split(/\s+/);
  for (const lexiconTerm of typeLexicon) {
    if (lexiconTerm === anchorLower) continue; // Already included
    
    const lexiconWords = lexiconTerm.split(/\s+/);
    
    // If they share at least one significant word (length > 3)
    const sharedWords = anchorWords.filter(aw => 
      aw.length > 3 && lexiconWords.some(lw => lw === aw || lw.includes(aw) || aw.includes(lw))
    );
    
    if (sharedWords.length > 0) {
      // Check if it's a reasonable variant (not too different)
      const similarity = sharedWords.length / Math.max(anchorWords.length, lexiconWords.length);
      if (similarity >= 0.5) { // At least 50% word overlap
        variants.add(lexiconTerm);
      }
    }
  }
  
  return Array.from(variants);
}

