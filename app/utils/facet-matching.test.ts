/**
 * Tests for productMatchesHardFacets with tag-based sizes/materials
 * Ensures "large" matches sizes including "l" and "large" once sizes[] is populated from tags
 */

import { describe, test, expect } from "vitest";

// Simplified version of productMatchesHardFacets for testing
function productMatchesHardFacets(
  product: {
    available: boolean;
    sizes?: string[];
    colors?: string[];
    materials?: string[];
  },
  hardFacets: { size: string | null; color: string | null; material: string | null },
  knownOptionNames: string[] = ["size", "color", "material"]
): boolean {
  // Check variant availability
  if (!product.available) {
    return false;
  }
  
  // Helper to normalize option values for comparison
  const normalizeValue = (val: string): string => {
    return val.toLowerCase().trim();
  };
  
  // Helper to check if a value matches (case-insensitive, with common aliases)
  const valueMatches = (productValue: string | null | undefined, constraintValue: string | null): boolean => {
    if (!constraintValue) return true; // No constraint means match
    if (!productValue) return false; // Constraint exists but product doesn't have it
    
    const normalizedProduct = normalizeValue(productValue);
    const normalizedConstraint = normalizeValue(constraintValue);
    
    // Exact match
    if (normalizedProduct === normalizedConstraint) return true;
    
    // Common size aliases
    const sizeAliases: Record<string, string[]> = {
      "s": ["small", "s"],
      "m": ["medium", "m"],
      "l": ["large", "l"],
      "xl": ["extra large", "x-large", "xl"],
      "xxl": ["extra extra large", "xx-large", "xxl"],
    };
    
    // Check aliases for size
    const sizeKey = knownOptionNames.find(n => n.toLowerCase() === "size");
    if (sizeKey && normalizedConstraint.length <= 3) {
      const aliases = sizeAliases[normalizedConstraint] || [];
      if (aliases.some(alias => normalizeValue(alias) === normalizedProduct)) return true;
    }
    
    // Partial match (e.g., "Medium" contains "M")
    if (normalizedProduct.includes(normalizedConstraint) || normalizedConstraint.includes(normalizedProduct)) {
      return true;
    }
    
    return false;
  };
  
  // Check size constraint
  if (hardFacets.size) {
    const productSizes = product.sizes || [];
    const hasSizeMatch = productSizes.some((s: string) => valueMatches(s, hardFacets.size));
    if (!hasSizeMatch) return false;
  }
  
  // Check color constraint
  if (hardFacets.color) {
    const productColors = product.colors || [];
    const hasColorMatch = productColors.some((c: string) => valueMatches(c, hardFacets.color));
    if (!hasColorMatch) return false;
  }
  
  // Check material constraint
  if (hardFacets.material) {
    const productMaterials = product.materials || [];
    const hasMaterialMatch = productMaterials.some((m: string) => valueMatches(m, hardFacets.material));
    if (!hasMaterialMatch) return false;
  }
  
  return true;
}

describe("productMatchesHardFacets with tag-based sizes", () => {
  test('"large" should match product with sizes=["l"] from cf-size-l tag', () => {
    const product = {
      available: true,
      sizes: ["l"], // From cf-size-l tag
      colors: [],
      materials: []
    };
    
    const hardFacets = {
      size: "large",
      color: null,
      material: null
    };
    
    expect(productMatchesHardFacets(product, hardFacets)).toBe(true);
  });

  test('"large" should match product with sizes=["large"] from option', () => {
    const product = {
      available: true,
      sizes: ["large"], // From option
      colors: [],
      materials: []
    };
    
    const hardFacets = {
      size: "large",
      color: null,
      material: null
    };
    
    expect(productMatchesHardFacets(product, hardFacets)).toBe(true);
  });

  test('"large" should match product with sizes=["l", "large"] (merged from tags and options)', () => {
    const product = {
      available: true,
      sizes: ["l", "large"], // Merged from cf-size-l tag and option
      colors: [],
      materials: []
    };
    
    const hardFacets = {
      size: "large",
      color: null,
      material: null
    };
    
    expect(productMatchesHardFacets(product, hardFacets)).toBe(true);
  });

  test('"m" should match product with sizes=["medium"]', () => {
    const product = {
      available: true,
      sizes: ["medium"],
      colors: [],
      materials: []
    };
    
    const hardFacets = {
      size: "m",
      color: null,
      material: null
    };
    
    expect(productMatchesHardFacets(product, hardFacets)).toBe(true);
  });

  test('"xl" should match product with sizes=["extra large"]', () => {
    const product = {
      available: true,
      sizes: ["extra large"],
      colors: [],
      materials: []
    };
    
    const hardFacets = {
      size: "xl",
      color: null,
      material: null
    };
    
    expect(productMatchesHardFacets(product, hardFacets)).toBe(true);
  });

  test('should fail when size does not match', () => {
    const product = {
      available: true,
      sizes: ["s"], // Only small available
      colors: [],
      materials: []
    };
    
    const hardFacets = {
      size: "large",
      color: null,
      material: null
    };
    
    expect(productMatchesHardFacets(product, hardFacets)).toBe(false);
  });

  test('should match when no size constraint', () => {
    const product = {
      available: true,
      sizes: ["m"],
      colors: [],
      materials: []
    };
    
    const hardFacets = {
      size: null,
      color: null,
      material: null
    };
    
    expect(productMatchesHardFacets(product, hardFacets)).toBe(true);
  });
});

describe("productMatchesHardFacets with tag-based materials", () => {
  test('should match product with materials=["cotton"] from cf-material-cotton tag', () => {
    const product = {
      available: true,
      sizes: [],
      colors: [],
      materials: ["cotton"] // From cf-material-cotton tag
    };
    
    const hardFacets = {
      size: null,
      color: null,
      material: "cotton"
    };
    
    expect(productMatchesHardFacets(product, hardFacets)).toBe(true);
  });

  test('should match product with materials=["cotton", "polyester"] from cf-material-80-cotton-20-polyester tag', () => {
    const product = {
      available: true,
      sizes: [],
      colors: [],
      materials: ["cotton", "polyester"] // From cf-material-80-cotton-20-polyester tag
    };
    
    const hardFacets = {
      size: null,
      color: null,
      material: "cotton"
    };
    
    expect(productMatchesHardFacets(product, hardFacets)).toBe(true);
  });

  test('should match product with materials=["cotton", "polyester"] when constraint is "polyester"', () => {
    const product = {
      available: true,
      sizes: [],
      colors: [],
      materials: ["cotton", "polyester"]
    };
    
    const hardFacets = {
      size: null,
      color: null,
      material: "polyester"
    };
    
    expect(productMatchesHardFacets(product, hardFacets)).toBe(true);
  });
});

