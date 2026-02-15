# Pipeline Flow Verification

## Complete Pipeline Flow (in order):

### 1. **Initial SmartFetch** (Line ~4341)
- ✅ Uses raw keywords from `extractSmartFetchSignals`
- ✅ Happens BEFORE term expansion
- ✅ Filters out generic words (products, contain, etc.) - FIXED

### 2. **LLM Intent Parsing** (Line ~5036)
- ✅ Parses user intent to extract hardTerms, softTerms, avoidTerms
- ✅ Returns structured intent

### 3. **TypeAnchor Selection** (Line ~5047)
- ✅ Selected from raw user intent (BEFORE expansion)
- ✅ Uses store-derived type lexicon
- ✅ This is CORRECT - TypeAnchor should match store's actual product types, not expanded terms

### 4. **Constraint Detection** (Line ~5054)
- ✅ Detects patterns like "contains", "with", "includes"
- ✅ Adds constraint terms to hardTerms
- ✅ Filters generic stopwords (acid, base, etc.)

### 5. **Experience Synonyms Expansion** (Line ~5129)
- ✅ Expands hardTerms using experience config synonyms
- ✅ One-hop expansion

### 6. **Term Expansion Pipeline** (Line ~5183)
- ✅ Expands hardTerms using:
  - Morphology (plural/singular, hyphen variants)
  - Locale variants (UK/US, French/English)
  - Multilingual (Spanish, French, German, etc.)
  - Abbreviations (EDP, EDT, etc.)
  - LLM synonyms (cached, 30 days)
- ✅ Returns `expandedHardTermsList`

### 7. **Update hardTerms** (Line ~5212)
- ✅ `hardTerms = expandedHardTermsList`
- ✅ This ensures all downstream steps use expanded terms

### 8. **Post-Expansion SmartFetch** (Line ~5237)
- ✅ Uses `expandedHardTermsList` for query building
- ✅ Triggers if:
  - Scarcity detected (count < minNeeded) OR
  - Candidates don't match expanded terms (FIXED)
- ✅ Uses field strategy (field_restricted, broad_text, two_pass)

### 9. **Gating** (Line ~7821)
- ✅ Uses `hardTerms` (which is now expanded)
- ✅ Strict gate requires ALL hard terms (when 2+ terms) or at least one (when 1 term)
- ✅ Uses morphology variants for matching
- ✅ Staged fallback if insufficient results

### 10. **TypeAnchor Filtering** (Line ~8310)
- ✅ Uses `primaryTypeAnchor` (selected from raw intent)
- ✅ Matches against store's product types/tags/collections
- ✅ Safety: Converts to boost if would shrink below minNeeded
- ✅ This is CORRECT - TypeAnchor should match store's actual types, not expanded terms

### 11. **BM25 Ranking** (Line ~8440)
- ✅ Uses `hardTerms` (expanded) for scoring
- ✅ Applies TypeAnchor boost if in boost mode
- ✅ Boosts exact phrase matches
- ✅ Boosts facet matches

### 12. **AI Ranking** (Line ~8500+)
- ✅ Uses expanded terms in context
- ✅ Ranks top candidates

## Issues Fixed:

1. ✅ **Generic words in SmartFetch**: Added "products", "contain", "that", etc. to stopwords
2. ✅ ✅ **Post-expansion SmartFetch skipped incorrectly**: Now checks if candidates match expanded terms, not just count

## Pipeline Correctness:

✅ **All steps use expanded terms correctly** (except TypeAnchor, which correctly uses store types)
✅ **Order is correct**: SmartFetch → Expansion → Post-Expansion SmartFetch → Gating → Ranking
✅ **TypeAnchor is correctly separate**: It matches store's product types, not expanded terms (this is intentional)

## Potential Improvements (not bugs):

- TypeAnchor could potentially use expanded terms for matching, but current implementation is correct (matches store types)
- Could add more logging for pipeline flow verification

