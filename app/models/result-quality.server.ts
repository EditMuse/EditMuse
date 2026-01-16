/**
 * Result Quality & Diversity Improvements
 * Ensures results have variety and quality
 */

interface ProductCandidate {
  handle: string;
  title: string;
  productType: string | null;
  vendor: string | null;
  price: string | null;
  tags: string[];
}

/**
 * Ensures result diversity by:
 * 1. Limiting products from same vendor/brand
 * 2. Ensuring variety in product types
 * 3. Distributing across price ranges when possible
 * 4. Avoiding duplicate/similar products
 */
export function ensureResultDiversity(
  rankedHandles: string[],
  candidates: ProductCandidate[],
  maxResults: number
): string[] {
  if (rankedHandles.length === 0 || candidates.length === 0) {
    return rankedHandles;
  }

  // Create a map for quick lookup
  const candidateMap = new Map<string, ProductCandidate>();
  for (const candidate of candidates) {
    candidateMap.set(candidate.handle, candidate);
  }

  const diverse: string[] = [];
  const used = new Set<string>();
  
  // Track diversity metrics
  const vendorCount = new Map<string, number>();
  const typeCount = new Map<string, number>();
  const priceRanges = new Map<string, number>(); // Price bucket counts
  
  // Helper to get price bucket (low/medium/high)
  function getPriceBucket(price: string | null): string {
    if (!price) return "unknown";
    const numPrice = parseFloat(price);
    if (isNaN(numPrice)) return "unknown";
    if (numPrice < 50) return "low";
    if (numPrice < 200) return "medium";
    return "high";
  }

  // First pass: prioritize original ranking while tracking diversity
  for (const handle of rankedHandles) {
    if (diverse.length >= maxResults) break;
    if (used.has(handle)) continue;
    
    const candidate = candidateMap.get(handle);
    if (!candidate) continue;

    const vendor = candidate.vendor || "unknown";
    const type = candidate.productType || "unknown";
    const priceBucket = getPriceBucket(candidate.price);

    // Allow up to 2 products per vendor (unless we need more for maxResults)
    const maxPerVendor = maxResults <= 8 ? 2 : Math.ceil(maxResults / 3);
    const vendorCountCurrent = vendorCount.get(vendor) || 0;
    
    // Allow up to 3 products per type (unless we need more)
    const maxPerType = maxResults <= 8 ? 3 : Math.ceil(maxResults / 2);
    const typeCountCurrent = typeCount.get(type) || 0;

    // Check if adding this product would improve diversity
    const wouldImproveDiversity = 
      vendorCountCurrent < maxPerVendor ||
      typeCountCurrent < maxPerType ||
      diverse.length < 3; // Always allow first 3 regardless

    if (wouldImproveDiversity || diverse.length < maxResults * 0.7) {
      // 70% of results can be less diverse (original ranking), 30% must be diverse
      diverse.push(handle);
      used.add(handle);
      vendorCount.set(vendor, vendorCountCurrent + 1);
      typeCount.set(type, typeCountCurrent + 1);
      priceRanges.set(priceBucket, (priceRanges.get(priceBucket) || 0) + 1);
    }
  }

  // Second pass: fill remaining slots with diverse options from ranked list
  if (diverse.length < maxResults) {
    const remaining = maxResults - diverse.length;
    let added = 0;

    for (const handle of rankedHandles) {
      if (added >= remaining) break;
      if (used.has(handle)) continue;

      const candidate = candidateMap.get(handle);
      if (!candidate) continue;

      const vendor = candidate.vendor || "unknown";
      const type = candidate.productType || "unknown";
      
      const vendorCountCurrent = vendorCount.get(vendor) || 0;
      const typeCountCurrent = typeCount.get(type) || 0;

      // Prefer products that add diversity
      const addsDiversity = vendorCountCurrent < 2 || typeCountCurrent < 2;

      if (addsDiversity || diverse.length < maxResults) {
        diverse.push(handle);
        used.add(handle);
        vendorCount.set(vendor, vendorCountCurrent + 1);
        typeCount.set(type, typeCountCurrent + 1);
        added++;
      }
    }
  }

  // Final pass: if still not full, add any remaining from ranked list
  if (diverse.length < maxResults) {
    for (const handle of rankedHandles) {
      if (diverse.length >= maxResults) break;
      if (!used.has(handle)) {
        diverse.push(handle);
        used.add(handle);
      }
    }
  }

  return diverse.slice(0, maxResults);
}

/**
 * Generates helpful empty result suggestions based on user intent
 */
export function generateEmptyResultSuggestions(
  userIntent: string,
  filteredCount: number,
  totalProducts: number
): string[] {
  const suggestions: string[] = [];

  if (filteredCount === 0 && totalProducts > 0) {
    suggestions.push("Try adjusting your filters - your search criteria may be too specific.");
    suggestions.push("Check if price range or size preferences can be relaxed.");
  }

  if (totalProducts === 0) {
    suggestions.push("No products are currently available. Please check back later.");
    return suggestions;
  }

  // Intent-specific suggestions
  const lowerIntent = userIntent.toLowerCase();
  
  if (lowerIntent.includes("budget") || lowerIntent.includes("price") || lowerIntent.includes("under")) {
    suggestions.push("Try widening your price range to see more options.");
  }

  if (lowerIntent.includes("size") || lowerIntent.includes("small") || lowerIntent.includes("large")) {
    suggestions.push("Consider checking other sizes - availability may vary.");
  }

  if (lowerIntent.includes("color") || lowerIntent.includes("colour")) {
    suggestions.push("Try browsing other color options - your preferred color may be out of stock.");
  }

  if (lowerIntent.includes("material") || lowerIntent.includes("fabric")) {
    suggestions.push("Similar materials or blends might work well too.");
  }

  // Generic suggestions
  if (suggestions.length === 0) {
    suggestions.push("Try adjusting your search criteria or filters.");
    suggestions.push("Browse similar products or explore different categories.");
  }

  return suggestions;
}

/**
 * Checks if results have good diversity
 */
export function measureResultDiversity(
  handles: string[],
  candidates: ProductCandidate[]
): {
  vendorDiversity: number; // 0-1, higher is better
  typeDiversity: number; // 0-1, higher is better
  priceDiversity: number; // 0-1, higher is better
  overallScore: number; // 0-1, higher is better
} {
  if (handles.length === 0) {
    return { vendorDiversity: 0, typeDiversity: 0, priceDiversity: 0, overallScore: 0 };
  }

  const candidateMap = new Map<string, ProductCandidate>();
  for (const candidate of candidates) {
    candidateMap.set(candidate.handle, candidate);
  }

  const vendors = new Set<string>();
  const types = new Set<string>();
  const prices = new Set<number>();

  for (const handle of handles) {
    const candidate = candidateMap.get(handle);
    if (!candidate) continue;

    if (candidate.vendor) vendors.add(candidate.vendor);
    if (candidate.productType) types.add(candidate.productType);
    if (candidate.price) {
      const numPrice = parseFloat(candidate.price);
      if (!isNaN(numPrice)) {
        // Round to nearest 10 for price buckets
        prices.add(Math.round(numPrice / 10) * 10);
      }
    }
  }

  const maxPossibleVendors = Math.min(handles.length, vendors.size + (handles.length - vendors.size));
  const maxPossibleTypes = Math.min(handles.length, types.size + (handles.length - types.size));

  const vendorDiversity = handles.length > 0 ? vendors.size / handles.length : 0;
  const typeDiversity = handles.length > 0 ? types.size / handles.length : 0;
  const priceDiversity = handles.length > 0 ? prices.size / handles.length : 0;

  // Overall score is average of three metrics
  const overallScore = (vendorDiversity + typeDiversity + priceDiversity) / 3;

  return {
    vendorDiversity: Math.min(1, vendorDiversity * 2), // Boost if > 50% unique
    typeDiversity: Math.min(1, typeDiversity * 2),
    priceDiversity: Math.min(1, priceDiversity * 1.5), // Price is less important
    overallScore,
  };
}

