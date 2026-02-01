/**
 * Lightweight regression tests for bundle gating improvements
 * Industry-agnostic tests - no store assumptions
 */

// Mock product data structure
interface MockProduct {
  title: string;
  handle: string;
  productType?: string;
  tags?: string[];
  vendor?: string;
  description?: string;
  sizes?: string[];
  colors?: string[];
  materials?: string[];
  available?: boolean;
  price?: number;
}

// Mock helpers (simplified versions for testing)
function normalizeText(text: string): string {
  return text.toLowerCase().trim();
}

function extractSearchText(candidate: any): string {
  const parts: string[] = [];
  if (candidate.title) parts.push(candidate.title);
  if (candidate.handle) parts.push(candidate.handle);
  if (candidate.productType) parts.push(candidate.productType);
  if (Array.isArray(candidate.tags)) parts.push(...candidate.tags);
  if (candidate.vendor) parts.push(candidate.vendor);
  if (candidate.description) {
    const desc = candidate.description.replace(/<[^>]*>/g, "").substring(0, 400);
    parts.push(desc);
  }
  return parts.join(" ").replace(/\s+/g, " ").trim().toLowerCase();
}

function scoreProductForSlot(
  product: any,
  slotDescriptor: string,
  stopwords: Set<string> = new Set(["the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "of", "with", "by"])
): number {
  const normalizeToken = (text: string): string => {
    return text.toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  };
  
  const tokenize = (text: string): string[] => {
    return normalizeToken(text)
      .split(/\s+/)
      .filter(token => token.length > 0 && !stopwords.has(token));
  };
  
  const slotTokens = new Set(tokenize(slotDescriptor));
  if (slotTokens.size === 0) return 0;
  
  const productText = extractSearchText(product);
  const productTokens = new Set(tokenize(productText));
  
  let matchCount = 0;
  for (const token of slotTokens) {
    if (productTokens.has(token)) {
      matchCount++;
    }
  }
  
  const score = matchCount / slotTokens.size;
  
  const normalizedSlot = normalizeToken(slotDescriptor);
  const normalizedProduct = normalizeToken(productText);
  if (normalizedProduct.includes(normalizedSlot)) {
    return Math.min(1.0, score + 0.3);
  }
  
  return score;
}

function productMatchesHardFacets(
  product: any,
  hardFacets: { size: string | null; color: string | null; material: string | null },
  knownOptionNames: string[] = ["Size", "Color", "Material"]
): boolean {
  const hasAvailableVariant = product.available === true || 
    (product.variants && Array.isArray(product.variants) && product.variants.some((v: any) => 
      v.available === true || v.availableForSale === true
    ));
  
  if (!hasAvailableVariant) {
    return false;
  }
  
  const normalizeValue = (val: string): string => {
    return val.toLowerCase().trim();
  };
  
  const valueMatches = (productValue: string | null | undefined, constraintValue: string | null): boolean => {
    if (!constraintValue) return true;
    if (!productValue) return false;
    
    const normalizedProduct = normalizeValue(productValue);
    const normalizedConstraint = normalizeValue(constraintValue);
    
    if (normalizedProduct === normalizedConstraint) return true;
    if (normalizedProduct.includes(normalizedConstraint) || normalizedConstraint.includes(normalizedProduct)) {
      return true;
    }
    
    return false;
  };
  
  if (hardFacets.size) {
    const productSizes = product.sizes || [];
    const hasSizeMatch = productSizes.some((s: string) => valueMatches(s, hardFacets.size));
    if (!hasSizeMatch) return false;
  }
  
  if (hardFacets.color) {
    const productColors = product.colors || [];
    const hasColorMatch = productColors.some((c: string) => valueMatches(c, hardFacets.color));
    if (!hasColorMatch) return false;
  }
  
  if (hardFacets.material) {
    const productMaterials = product.materials || [];
    const hasMaterialMatch = productMaterials.some((m: string) => valueMatches(m, hardFacets.material));
    if (!hasMaterialMatch) return false;
  }
  
  return true;
}

function getNonFacetHardTerms(
  hardTerms: string[],
  facets: { size: string | null; color: string | null; material: string | null }
): string[] {
  const facetValues: string[] = [];
  if (facets.size) facetValues.push(facets.size.toLowerCase().trim());
  if (facets.color) facetValues.push(facets.color.toLowerCase().trim());
  if (facets.material) facetValues.push(facets.material.toLowerCase().trim());
  
  if (facetValues.length === 0) {
    return hardTerms;
  }
  
  return hardTerms.filter(term => {
    const termLower = term.toLowerCase().trim();
    return !facetValues.some(facet => facet === termLower);
  });
}

// Test cases
export function runTests(): { passed: number; failed: number; errors: string[] } {
  let passed = 0;
  let failed = 0;
  const errors: string[] = [];
  
  // Test 1: productMatchesHardFacets with size constraint
  try {
    const product1: MockProduct = {
      title: "Blue Shirt",
      handle: "blue-shirt",
      sizes: ["Small", "Medium", "Large"],
      colors: ["Blue"],
      available: true,
    };
    const result1 = productMatchesHardFacets(product1, { size: "Medium", color: null, material: null });
    if (result1) {
      passed++;
    } else {
      failed++;
      errors.push("Test 1 failed: productMatchesHardFacets should match size 'Medium'");
    }
  } catch (e) {
    failed++;
    errors.push(`Test 1 error: ${e}`);
  }
  
  // Test 2: productMatchesHardFacets rejects unavailable
  try {
    const product2: MockProduct = {
      title: "Red Shirt",
      handle: "red-shirt",
      sizes: ["Medium"],
      available: false,
    };
    const result2 = productMatchesHardFacets(product2, { size: "Medium", color: null, material: null });
    if (!result2) {
      passed++;
    } else {
      failed++;
      errors.push("Test 2 failed: productMatchesHardFacets should reject unavailable products");
    }
  } catch (e) {
    failed++;
    errors.push(`Test 2 error: ${e}`);
  }
  
  // Test 3: scoreProductForSlot - high score for good match
  try {
    const product3: MockProduct = {
      title: "Laptop Computer",
      handle: "laptop-computer",
      productType: "Electronics",
      tags: ["laptop", "computer", "portable"],
    };
    const score3 = scoreProductForSlot(product3, "laptop");
    if (score3 >= 0.5) {
      passed++;
    } else {
      failed++;
      errors.push(`Test 3 failed: scoreProductForSlot should return high score for good match, got ${score3}`);
    }
  } catch (e) {
    failed++;
    errors.push(`Test 3 error: ${e}`);
  }
  
  // Test 4: scoreProductForSlot - low score for poor match
  try {
    const product4: MockProduct = {
      title: "Coffee Table",
      handle: "coffee-table",
      productType: "Furniture",
    };
    const score4 = scoreProductForSlot(product4, "laptop");
    if (score4 < 0.3) {
      passed++;
    } else {
      failed++;
      errors.push(`Test 4 failed: scoreProductForSlot should return low score for poor match, got ${score4}`);
    }
  } catch (e) {
    failed++;
    errors.push(`Test 4 error: ${e}`);
  }
  
  // Test 5: getNonFacetHardTerms filters out facets
  try {
    const hardTerms = ["blue", "shirt", "medium"];
    const facets = { size: "medium", color: "blue", material: null };
    const result5 = getNonFacetHardTerms(hardTerms, facets);
    if (result5.length === 1 && result5[0] === "shirt") {
      passed++;
    } else {
      failed++;
      errors.push(`Test 5 failed: getNonFacetHardTerms should filter out facets, got ${result5.join(", ")}`);
    }
  } catch (e) {
    failed++;
    errors.push(`Test 5 error: ${e}`);
  }
  
  // Test 6: Token-based scoring prevents naive substring match
  try {
    const product6: MockProduct = {
      title: "Suit Trouser",
      handle: "suit-trouser",
      productType: "Pants",
    };
    const score6a = scoreProductForSlot(product6, "suit");
    const score6b = scoreProductForSlot(product6, "trouser");
    // "suit-trouser" should score higher for "trouser" than for "suit" (more tokens match)
    if (score6b > score6a || (score6a < 0.5 && score6b >= 0.5)) {
      passed++;
    } else {
      failed++;
      errors.push(`Test 6 failed: Token-based scoring should prevent naive substring match. suit=${score6a}, trouser=${score6b}`);
    }
  } catch (e) {
    failed++;
    errors.push(`Test 6 error: ${e}`);
  }
  
  return { passed, failed, errors };
}

// Run tests if executed directly
if (require.main === module) {
  const results = runTests();
  console.log(`Tests: ${results.passed} passed, ${results.failed} failed`);
  if (results.errors.length > 0) {
    console.error("Errors:", results.errors);
  }
}

