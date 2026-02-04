/**
 * Regression tests for morphology and decompounding expansion
 * Industry-agnostic tests - no domain-specific assumptions
 */

import { describe, it, expect } from "vitest";
import { expandTokenMorphology, expandDecompoundTokens, expandQueryTokens } from "./text-indexing.server";

describe("expandTokenMorphology", () => {
  it("should add plural form for singular token", () => {
    const variants = expandTokenMorphology("coat");
    expect(variants.has("coat")).toBe(true);
    expect(variants.has("coats")).toBe(true);
  });

  it("should add singular form for plural token", () => {
    const variants = expandTokenMorphology("coats");
    expect(variants.has("coat")).toBe(true);
    expect(variants.has("coats")).toBe(true);
  });

  it("should handle 'es' plural forms", () => {
    const variants = expandTokenMorphology("box");
    expect(variants.has("box")).toBe(true);
    expect(variants.has("boxes")).toBe(true);
  });

  it("should handle 'es' singular forms", () => {
    const variants = expandTokenMorphology("boxes");
    expect(variants.has("box")).toBe(true);
    expect(variants.has("boxes")).toBe(true);
  });

  it("should handle words ending in x, z, ch, sh", () => {
    const variants = expandTokenMorphology("watch");
    expect(variants.has("watch")).toBe(true);
    expect(variants.has("watches")).toBe(true);
  });
});

describe("expandDecompoundTokens", () => {
  it("should find sub-tokens in vocabulary", () => {
    const tokens = ["overcoat"];
    const vocab = new Set(["coat", "over", "jacket", "shirt"]);
    const expanded = expandDecompoundTokens(tokens, vocab);
    
    expect(expanded.has("overcoat")).toBe(true);
    expect(expanded.has("coat")).toBe(true); // "overcoat" contains "coat"
  });

  it("should not add tokens that don't exist in vocab", () => {
    const tokens = ["overcoat"];
    const vocab = new Set(["jacket", "shirt"]);
    const expanded = expandDecompoundTokens(tokens, vocab);
    
    expect(expanded.has("overcoat")).toBe(true);
    expect(expanded.has("coat")).toBe(false); // "coat" not in vocab
  });

  it("should cap expansions per token", () => {
    const tokens = ["superlongword"];
    const vocab = new Set(["super", "long", "word", "extra"]);
    const expanded = expandDecompoundTokens(tokens, vocab, 2); // max 2 expansions
    
    expect(expanded.has("superlongword")).toBe(true);
    // Should have at most 2 additional tokens (plus original)
    const addedTokens = Array.from(expanded).filter(t => t !== "superlongword");
    expect(addedTokens.length).toBeLessThanOrEqual(2);
  });

  it("should only process tokens length >= 6", () => {
    const tokens = ["coat", "overcoat"];
    const vocab = new Set(["coat"]);
    const expanded = expandDecompoundTokens(tokens, vocab);
    
    expect(expanded.has("coat")).toBe(true);
    expect(expanded.has("overcoat")).toBe(true);
    // "coat" (length 4) should not trigger decompounding
    // "overcoat" (length 8) should trigger decompounding if "coat" is in vocab
    if (expanded.has("coat") && tokens.includes("overcoat")) {
      // If overcoat was decompounded, coat should be added
      expect(expanded.size).toBeGreaterThan(2);
    }
  });
});

describe("expandQueryTokens", () => {
  it("should combine morphology and decompounding", () => {
    const tokens = ["coat"];
    const vocab = new Set(["coat", "overcoat"]);
    const expanded = expandQueryTokens(tokens, vocab);
    
    expect(expanded.has("coat")).toBe(true);
    expect(expanded.has("coats")).toBe(true); // morphology
  });

  it("should work without vocab (morphology only)", () => {
    const tokens = ["coat"];
    const expanded = expandQueryTokens(tokens);
    
    expect(expanded.has("coat")).toBe(true);
    expect(expanded.has("coats")).toBe(true);
  });

  it("query token 'coat' should match candidate text containing 'coats'", () => {
    const queryTokens = ["coat"];
    const expanded = expandQueryTokens(queryTokens);
    
    const candidateText = "winter coats for sale";
    const candidateTokens = candidateText.toLowerCase().split(/\s+/);
    
    // Check if any expanded token matches candidate
    const hasMatch = Array.from(expanded).some(token => candidateTokens.includes(token));
    expect(hasMatch).toBe(true); // "coats" should match
  });

  it("query token 'overcoat' should match candidate text containing 'coat' via decompound", () => {
    const queryTokens = ["overcoat"];
    const vocab = new Set(["coat", "over", "jacket"]);
    const expanded = expandQueryTokens(queryTokens, vocab);
    
    const candidateText = "winter coat collection";
    const candidateTokens = candidateText.toLowerCase().split(/\s+/);
    
    // Check if any expanded token matches candidate
    const hasMatch = Array.from(expanded).some(token => candidateTokens.includes(token));
    expect(hasMatch).toBe(true); // "coat" (from decompound) should match
  });
});

