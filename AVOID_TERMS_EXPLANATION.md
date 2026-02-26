# How Avoid Terms Work in Bundle vs Single-Item Queries

## Overview

Avoid terms (negative terms like "no patterns", "without perfume", "avoid prints") are extracted from user queries and used to filter out products that contain these terms. The implementation is **industry-agnostic** and works consistently across both bundle and single-item queries, with some differences in when and where filtering occurs.

---

## 1. Avoid Terms Extraction

### When: Intent Parsing Phase (Layer 2)

Avoid terms are extracted during the **Intent Parsing** phase, which happens **after** initial product fetching but **before** gating and ranking.

### How: LLM-First Approach

1. **Primary Method**: LLM Intent Parsing
   - The system uses OpenAI to parse user intent and extract `avoidTerms` array
   - LLM understands context: "no patterns or prints" → `["patterns", "prints"]`
   - Handles misspellings: "paterns" → correctly identified as "patterns"

2. **Fallback Method**: Pattern-Based Extraction
   - If LLM fails, pattern matching extracts avoid terms:
   - Patterns: `"no X"`, `"not X"`, `"without X"`, `"avoid X"`, `"don't X"`, `"exclude X"`
   - Example: "I want a white shirt, no patterns or prints" → `["patterns", "prints"]`

### Normalization

Avoid terms are normalized to handle:
- **Misspellings**: "paterns" → "patterns", "patern" → "pattern"
- **Plural/Singular**: "prints" → ["prints", "print"], "pattern" → ["pattern", "patterns"]
- **Word boundaries**: Uses regex `\b` to match whole words only

---

## 2. Single-Item Query Flow

### Step 1: Early Filtering (After Initial Fetch)

**Location**: `filterCandidatesByAvoidTerms()` - Applied right after initial product enrichment

**When**: After `allCandidatesEnriched` is populated (around line 5300)

**How**:
```typescript
// Normalize avoid terms (handles misspellings, plural/singular)
const avoidTermVariants = new Set<string>();
for (const avoidTerm of avoidTerms) {
  const variants = normalizeAvoidTerm(avoidTerm);
  variants.forEach(v => avoidTermVariants.add(v));
}

// Filter products that contain any avoid term variant
const filtered = allCandidatesEnriched.filter(candidate => {
  const searchableText = candidate.searchText; // title, productType, tags, vendor, handle
  const hasAvoidTerm = Array.from(avoidTermVariants).some(variant => {
    const pattern = new RegExp(`\\b${variant}\\b`, 'i');
    return pattern.test(searchableText);
  });
  return !hasAvoidTerm;
});
```

**Fields Checked**:
- `title`
- `productType`
- `tags`
- `vendor`
- `handle`
- `description` (if available)

### Step 2: SmartFetch Filtering (During Product Fetching)

**Location**: `filterNegativeMatches()` - Applied during SmartFetch steps

**When**: During SmartFetch query execution (Step A, Step B, Step C)

**How**:
- Filters products that match negative patterns:
  - `"no perfume"`, `"no-perfume"`, `"0% perfume"` → filtered out
  - `"perfume-free"`, `"perfume free"` → filtered out
  - `"non food products"` (when searching "pet food") → filtered out

**Pattern Matching**:
```typescript
const negativeIndicators = ["no", "sans", "free", "without", "not", "non", "zero", "0"];
// Checks for patterns like:
// - "no perfume" (space)
// - "no-perfume" (hyphen)
// - "0% perfume" (percentage)
// - "perfume-free" (hyphen)
// - "perfume free" (space)
```

### Step 3: Strict Gate Filtering (Before AI Ranking)

**Location**: Strict gate phase (around line 8874)

**When**: After facet gating, before AI ranking

**How**:
- Re-applies avoid term filtering to the strict gate pool
- Ensures no avoid terms slip through before AI ranking
- Uses same normalization logic as Step 1

### Step 4: AI Ranking Validation

**Location**: `ai-ranking.server.ts` - Post-AI validation (around line 2213)

**When**: After AI returns selected products, before final results

**How**:
- Validates each AI-selected product against avoid terms
- If a product contains an avoid term variant, it's **skipped** (not included in results)
- Logs: `[AI Ranking] Skipping {handle} - contains avoidTerm variant`

**Fields Checked**:
- `title`
- `tags`
- `descriptionSnippet` (first 400-800 chars)

---

## 3. Bundle Query Flow

### Step 1: Bundle Retrieval Filtering (Per-Item Fetching)

**Location**: `bundleRetrieval` - During per-item product fetching (around line 6550)

**When**: When fetching products for each bundle item (e.g., "shirt", "tie", "suit")

**How**:
- For each bundle item, filters products that contain negative patterns related to that item type
- Example: For bundle item "shirt", filters out:
  - `"no-shirt"`, `"non-shirt"`, `"0% shirt"` products
  - Products with handle like `"no-shirt-product"`

**Pattern Matching** (Same as SmartFetch):
```typescript
const negativeIndicators = ["no", "sans", "free", "without", "not", "non", "zero", "0"];
// Checks itemType against negative patterns:
// - "no shirt" (space)
// - "no-shirt" (hyphen)
// - "0% shirt" (percentage)
// - "shirt-free" (hyphen)
```

**Fields Checked**:
- `title`
- `productType`
- `tags`
- `vendor`
- `handle`

### Step 2: Bundle Gating (Per-Item Pool)

**Location**: Bundle gating phase (around line 10286)

**When**: After bundle retrieval, when building per-item candidate pools

**How**:
- Avoid terms are applied to each bundle item's candidate pool
- Uses same normalization logic as single-item queries
- Filters products that contain avoid term variants in their searchable text

### Step 3: AI Bundle Ranking Validation

**Location**: `ai-ranking.server.ts` - Post-AI validation (same as single-item)

**When**: After AI returns selected products for bundle, before final results

**How**:
- Validates each AI-selected product against avoid terms
- Same validation logic as single-item queries
- Products containing avoid terms are skipped

---

## 4. Key Differences: Bundle vs Single-Item

| Aspect | Single-Item | Bundle |
|--------|-------------|--------|
| **Early Filtering** | ✅ Applied to entire candidate pool | ❌ Not applied globally (per-item only) |
| **SmartFetch Filtering** | ✅ Applied during SmartFetch steps | ❌ Skipped (bundle uses per-item retrieval) |
| **Bundle Retrieval Filtering** | ❌ N/A | ✅ Applied per-item during bundle retrieval |
| **Strict Gate Filtering** | ✅ Applied before AI ranking | ✅ Applied per-item before AI ranking |
| **AI Validation** | ✅ Validates all selected products | ✅ Validates all selected products (per bundle item) |
| **Normalization** | ✅ Same normalization logic | ✅ Same normalization logic |

---

## 5. Normalization Details

### `normalizeAvoidTerm()` Function

**Location**: Defined inline in both `app-proxy-session-start.server.ts` and `ai-ranking.server.ts`

**Handles**:
1. **Misspellings**:
   - "paterns" → ["paterns", "patterns"]
   - "patern" → ["patern", "pattern"]
   - "pater" → ["pater", "pattern"]

2. **Plural/Singular**:
   - "prints" → ["prints", "print"]
   - "pattern" → ["pattern", "patterns"]
   - "coats" → ["coats", "coat"]
   - "coat" → ["coat", "coats"]

3. **Special Endings**:
   - Words ending in `s`, `x`, `z`, `ch`, `sh` → adds "es" variant
   - Example: "box" → ["box", "boxes"]

**Word Boundary Matching**:
- Uses regex `\b` to ensure whole-word matching
- Prevents false positives (e.g., "pattern" won't match "patterns" as substring)
- Case-insensitive matching

---

## 6. Example Flows

### Example 1: Single-Item Query
**Query**: "I want a white shirt, no patterns or prints"

**Flow**:
1. **Intent Parsing**: Extracts `avoidTerms = ["patterns", "prints"]`
2. **Early Filtering**: Filters `allCandidatesEnriched` → removes products with "pattern", "patterns", "print", "prints" in title/tags/handle
3. **SmartFetch**: If needed, filters negative matches during fetch
4. **Strict Gate**: Re-applies avoid term filter to strict gate pool
5. **AI Ranking**: AI selects products, then validation skips any that contain avoid terms
6. **Result**: Only white shirts without patterns or prints

### Example 2: Bundle Query
**Query**: "I want a white shirt, no patterns, and a black tie"

**Flow**:
1. **Intent Parsing**: Extracts `avoidTerms = ["patterns"]`, `bundleItems = ["shirt", "tie"]`
2. **Bundle Retrieval (Shirt)**:
   - Fetches products for "shirt"
   - Filters out products with "no-shirt", "non-shirt", "0% shirt" patterns
   - Filters out products with "pattern", "patterns" in title/tags/handle
3. **Bundle Retrieval (Tie)**:
   - Fetches products for "tie"
   - Filters out products with "no-tie", "non-tie" patterns
   - (No "patterns" filter for tie - avoid terms apply globally)
4. **Bundle Gating**: Applies avoid term filter to each item's candidate pool
5. **AI Bundle Ranking**: AI selects products per item, validation skips any with avoid terms
6. **Result**: White shirt (no patterns) + black tie

---

## 7. Important Notes

1. **Industry-Agnostic**: Avoid term filtering works for any industry (fashion, beauty, electronics, etc.)

2. **Consistent Logic**: Same normalization and filtering logic used in both bundle and single-item queries

3. **Multiple Checkpoints**: Avoid terms are checked at multiple stages to ensure no products slip through:
   - Early filtering (single-item only)
   - SmartFetch filtering (single-item only)
   - Bundle retrieval filtering (bundle only)
   - Strict gate filtering (both)
   - AI validation (both)

4. **Word Boundary Matching**: Uses `\b` regex to prevent substring false positives

5. **Misspelling Handling**: Handles common misspellings like "paterns" → "patterns"

6. **Plural/Singular Handling**: Automatically handles both forms (e.g., "print" and "prints")

7. **Global vs Per-Item**: In bundles, avoid terms apply globally (affect all items), but filtering happens per-item during bundle retrieval

---

## 8. Logging

The system logs avoid term filtering at various stages:

- `[AvoidFilter] filtered={count} remaining={count} avoidTerms=[...]`
- `[SmartFetch] filtered_negative_matches={count} remaining={count}`
- `[BundleRetrieval] filtered_negative_matches={count} remaining={count}`
- `[AI Ranking] Skipping {handle} - contains avoidTerm variant`

These logs help debug why products are being filtered out.

