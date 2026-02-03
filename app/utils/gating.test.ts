/**
 * Unit tests for strict gating and noMatch scenarios
 * Tests industry-agnostic gating logic
 */

import { describe, it, expect } from "vitest";

/**
 * Test helper: Simulates strict gating with AND logic
 */
function strictGateWithAND(
  candidates: Array<{ searchText: string; title: string; tags: string[]; optionValues?: Record<string, string[]> }>,
  hardTerms: string[]
): Array<{ searchText: string; title: string }> {
  const requireAll = hardTerms.length >= 2;
  
  return candidates.filter(candidate => {
    const haystack = candidate.searchText.toLowerCase();
    
    if (requireAll) {
      // AND logic: ALL terms must match
      return hardTerms.every(term => {
        const normalized = term.toLowerCase();
        // Simple word boundary match for testing
        const regex = new RegExp(`\\b${normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
        return regex.test(haystack);
      });
    } else {
      // OR logic: at least one term must match
      return hardTerms.some(term => {
        const normalized = term.toLowerCase();
        const regex = new RegExp(`\\b${normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
        return regex.test(haystack);
      });
    }
  });
}

describe("Strict Gating - AND Logic", () => {
  it('"blue suit" excludes non-blue suits when blue is a hard term', () => {
    const candidates = [
      { searchText: "navy blue business suit", title: "Navy Blue Suit", tags: ["blue", "suit"], optionValues: { color: ["blue"] } },
      { searchText: "black formal suit", title: "Black Suit", tags: ["black", "suit"], optionValues: { color: ["black"] } },
      { searchText: "blue casual suit", title: "Blue Casual Suit", tags: ["blue", "suit"], optionValues: { color: ["blue"] } },
      { searchText: "gray business suit", title: "Gray Suit", tags: ["gray", "suit"], optionValues: { color: ["gray"] } },
    ];
    
    const hardTerms = ["blue", "suit"];
    const result = strictGateWithAND(candidates, hardTerms);
    
    // Should only include suits that have "blue" in searchText
    expect(result.length).toBe(2);
    expect(result.map(r => r.title)).toContain("Navy Blue Suit");
    expect(result.map(r => r.title)).toContain("Blue Casual Suit");
    expect(result.map(r => r.title)).not.toContain("Black Suit");
    expect(result.map(r => r.title)).not.toContain("Gray Suit");
  });
  
  it('"blue shirt" requires both terms (AND logic)', () => {
    const candidates = [
      { searchText: "blue cotton shirt", title: "Blue Shirt", tags: ["blue", "shirt"] },
      { searchText: "red cotton shirt", title: "Red Shirt", tags: ["red", "shirt"] },
      { searchText: "blue denim jeans", title: "Blue Jeans", tags: ["blue", "jeans"] },
      { searchText: "white formal shirt", title: "White Shirt", tags: ["white", "shirt"] },
    ];
    
    const hardTerms = ["blue", "shirt"];
    const result = strictGateWithAND(candidates, hardTerms);
    
    // Should only include items that have BOTH "blue" AND "shirt"
    expect(result.length).toBe(1);
    expect(result[0].title).toBe("Blue Shirt");
  });
  
  it('single term "suit" uses OR logic (matches any suit)', () => {
    const candidates = [
      { searchText: "blue business suit", title: "Blue Suit", tags: ["blue", "suit"] },
      { searchText: "black formal suit", title: "Black Suit", tags: ["black", "suit"] },
      { searchText: "red casual shirt", title: "Red Shirt", tags: ["red", "shirt"] },
    ];
    
    const hardTerms = ["suit"];
    const result = strictGateWithAND(candidates, hardTerms);
    
    // Should include all suits (OR logic for single term)
    expect(result.length).toBe(2);
    expect(result.map(r => r.title)).toContain("Blue Suit");
    expect(result.map(r => r.title)).toContain("Black Suit");
    expect(result.map(r => r.title)).not.toContain("Red Shirt");
  });
});

describe("NoMatch Scenarios", () => {
  it('"overcoat" returns noMatch when catalog has no synonyms and no matching terms', () => {
    const candidates = [
      { searchText: "winter jacket", title: "Winter Jacket", tags: ["jacket"] },
      { searchText: "rain coat", title: "Rain Coat", tags: ["coat"] },
      { searchText: "summer shirt", title: "Summer Shirt", tags: ["shirt"] },
    ];
    
    const hardTerms = ["overcoat"];
    const searchSynonyms: Record<string, string[]> = {}; // No synonyms configured
    
    const result = strictGateWithAND(candidates, hardTerms);
    
    // Should return 0 matches (noMatch = true)
    expect(result.length).toBe(0);
    
    // If synonyms were configured, we'd expand "overcoat" -> ["coat", "outerwear", "jacket"]
    // But without synonyms, strict gate returns 0
    const expandedTerms = hardTerms; // No expansion without synonyms
    const expandedResult = strictGateWithAND(candidates, expandedTerms);
    expect(expandedResult.length).toBe(0);
  });
  
  it('"overcoat" with synonyms expands and finds matches', () => {
    const candidates = [
      { searchText: "winter jacket", title: "Winter Jacket", tags: ["jacket"] },
      { searchText: "rain coat", title: "Rain Coat", tags: ["coat"] },
      { searchText: "summer shirt", title: "Summer Shirt", tags: ["shirt"] },
    ];
    
    const hardTerms = ["overcoat"];
    const searchSynonyms: Record<string, string[]> = {
      "overcoat": ["coat", "outerwear", "jacket"]
    };
    
    // Expand terms with synonyms
    const expandedTerms = [...hardTerms];
    const synonyms = searchSynonyms[hardTerms[0].toLowerCase()] || [];
    expandedTerms.push(...synonyms);
    
    // First try strict gate with original term (should fail)
    const strictResult = strictGateWithAND(candidates, hardTerms);
    expect(strictResult.length).toBe(0);
    
    // Then try with expanded terms (should succeed)
    const expandedResult = strictGateWithAND(candidates, expandedTerms);
    expect(expandedResult.length).toBeGreaterThan(0);
    expect(expandedResult.map(r => r.title)).toContain("Winter Jacket");
    expect(expandedResult.map(r => r.title)).toContain("Rain Coat");
  });
});

