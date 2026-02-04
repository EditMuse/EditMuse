/**
 * Industry-agnostic facet extraction and matching
 * Works with any Shopify store (fashion, beauty, home, etc.)
 * Primary source of truth: Shopify variant selectedOptions + metafields
 * Tags like cf-size-* are optional fallback adapters only
 */

/**
 * Normalize option name for comparison
 * Maps common variants (e.g., colour->color) but keeps mapping small and generic
 */
export function normalizeOptionName(name: string): string {
  if (!name || typeof name !== "string") return "";
  
  const normalized = name.toLowerCase().trim();
  
  // Small generic mapping for common variants
  const nameMap: Record<string, string> = {
    "colour": "color",
    "colours": "color",
    "sizing": "size",
    "sizes": "size",
  };
  
  return nameMap[normalized] || normalized;
}

/**
 * Discover facet vocabulary from candidate pool
 * Scans product variants' selectedOptions and builds a set of:
 * - option names seen (e.g. Size, Color, Shade, Scent, Finish, Pack Size, Capacity, Material, Length)
 * - values seen for each option name
 */
export function discoverFacetVocabulary(
  candidates: Array<{
    variants?: Array<{
      selectedOptions?: Array<{ name: string; value: string }>;
    }>;
    optionValues?: Record<string, string[]>;
  }>
): {
  optionNames: Set<string>;
  optionNameToValues: Map<string, Set<string>>;
} {
  const optionNames = new Set<string>();
  const optionNameToValues = new Map<string, Set<string>>();
  
  for (const candidate of candidates) {
    // Scan variants' selectedOptions
    if (Array.isArray(candidate.variants)) {
      for (const variant of candidate.variants) {
        if (Array.isArray(variant.selectedOptions)) {
          for (const option of variant.selectedOptions) {
            if (option.name && option.value) {
              const normalizedName = normalizeOptionName(option.name);
              if (normalizedName) {
                optionNames.add(normalizedName);
                if (!optionNameToValues.has(normalizedName)) {
                  optionNameToValues.set(normalizedName, new Set<string>());
                }
                optionNameToValues.get(normalizedName)!.add(option.value.toLowerCase().trim());
              }
            }
          }
        }
      }
    }
    
    // Also scan optionValues (from REST API format)
    if (candidate.optionValues && typeof candidate.optionValues === "object") {
      for (const [optionName, values] of Object.entries(candidate.optionValues)) {
        if (optionName && Array.isArray(values)) {
          const normalizedName = normalizeOptionName(optionName);
          if (normalizedName) {
            optionNames.add(normalizedName);
            if (!optionNameToValues.has(normalizedName)) {
              optionNameToValues.set(normalizedName, new Set<string>());
            }
            for (const value of values) {
              if (typeof value === "string") {
                optionNameToValues.get(normalizedName)!.add(value.toLowerCase().trim());
              }
            }
          }
        }
      }
    }
  }
  
  return { optionNames, optionNameToValues };
}

/**
 * Generic constraint structure
 */
export interface FacetConstraint {
  key: string; // Normalized option name (e.g., "size", "color", "scent", "capacity")
  value: string; // Constraint value (e.g., "large", "red", "vanilla", "200ml")
  scope?: "global" | "item"; // For bundle mode
}

/**
 * Check if a value matches a constraint (with conservative equivalence)
 * Supports a small generic equivalence map only when obvious:
 * l <-> large, xl <-> x-large, etc.
 */
function valueMatchesConstraint(
  productValue: string,
  constraintValue: string
): boolean {
  const normalizedProduct = productValue.toLowerCase().trim();
  const normalizedConstraint = constraintValue.toLowerCase().trim();
  
  // Exact match
  if (normalizedProduct === normalizedConstraint) return true;
  
  // Small generic size equivalence map (only for obvious cases)
  const sizeEquivalences: Record<string, string[]> = {
    "s": ["small", "s"],
    "m": ["medium", "m"],
    "l": ["large", "l"],
    "xl": ["extra large", "x-large", "xl", "extra-large"],
    "xxl": ["extra extra large", "xx-large", "xxl", "extra-extra-large"],
  };
  
  // Check size equivalences (only if constraint is a known size abbreviation)
  if (sizeEquivalences[normalizedConstraint]) {
    const aliases = sizeEquivalences[normalizedConstraint];
    if (aliases.some(alias => normalizedProduct === alias)) return true;
  }
  
  // Reverse check: if product value is abbreviation, check if constraint matches full form
  if (sizeEquivalences[normalizedProduct]) {
    const aliases = sizeEquivalences[normalizedProduct];
    if (aliases.some(alias => normalizedConstraint === alias)) return true;
  }
  
  // Partial match (conservative - only if one contains the other)
  if (normalizedProduct.includes(normalizedConstraint) || normalizedConstraint.includes(normalizedProduct)) {
    return true;
  }
  
  return false;
}

/**
 * Check if a variant satisfies constraints
 * Matches constraints against variant.selectedOptions (normalized option names)
 * If product has no variants or no matching option, returns false (caller should check product-level fallback)
 */
export function variantSatisfiesConstraints(
  variant: {
    selectedOptions?: Array<{ name: string; value: string }>;
  },
  constraints: FacetConstraint[]
): boolean {
  if (!Array.isArray(variant.selectedOptions) || variant.selectedOptions.length === 0) {
    return false; // No options to match against
  }
  
  // Build map of option name -> value from variant
  const variantOptions = new Map<string, string>();
  for (const option of variant.selectedOptions) {
    if (option.name && option.value) {
      const normalizedName = normalizeOptionName(option.name);
      variantOptions.set(normalizedName, option.value);
    }
  }
  
  // Check each constraint
  for (const constraint of constraints) {
    const normalizedKey = normalizeOptionName(constraint.key);
    const variantValue = variantOptions.get(normalizedKey);
    
    if (!variantValue) {
      // Constraint key not found in variant - fail
      return false;
    }
    
    // Check if value matches
    if (!valueMatchesConstraint(variantValue, constraint.value)) {
      return false;
    }
  }
  
  return true;
}

/**
 * Check if a product has at least one variant satisfying constraints
 */
export function productSatisfiesConstraints(
  product: {
    variants?: Array<{
      selectedOptions?: Array<{ name: string; value: string }>;
      availableForSale?: boolean;
    }>;
    available?: boolean;
  },
  constraints: FacetConstraint[],
  requireAvailable: boolean = true
): boolean {
  if (constraints.length === 0) {
    // No constraints - check availability only
    return !requireAvailable || product.available === true;
  }
  
  if (!Array.isArray(product.variants) || product.variants.length === 0) {
    // No variants - cannot satisfy variant constraints
    return false;
  }
  
  // Check if any variant satisfies constraints
  for (const variant of product.variants) {
    if (requireAvailable && variant.availableForSale !== true) {
      continue; // Skip unavailable variants
    }
    
    if (variantSatisfiesConstraints(variant, constraints)) {
      return true;
    }
  }
  
  return false;
}

/**
 * Extract constraints from tag patterns (optional fallback adapter)
 * Parses tags with generic prefix patterns:
 * - cf-size-*, cf-color-*, cf-material-*
 * - {key}-{value} and {key}:{value} patterns where key is one of the discovered option names
 */
export function extractConstraintsFromTags(
  tags: string[],
  discoveredOptionNames: Set<string>
): FacetConstraint[] {
  const constraints: FacetConstraint[] = [];
  const seen = new Set<string>(); // Dedupe by key+value
  
  if (!Array.isArray(tags)) return constraints;
  
  for (const tag of tags) {
    if (typeof tag !== "string") continue;
    
    // Pattern 1: cf-{key}-{value}
    if (tag.startsWith("cf-")) {
      const parts = tag.substring(3).split("-");
      if (parts.length >= 2) {
        const key = parts[0];
        const value = parts.slice(1).join("-");
        const normalizedKey = normalizeOptionName(key);
        
        // Only add if key matches a discovered option name (or is a known generic key)
        if (discoveredOptionNames.has(normalizedKey) || 
            ["size", "color", "material", "scent", "finish", "capacity", "length"].includes(normalizedKey)) {
          const constraintKey = `${normalizedKey}:${value}`;
          if (!seen.has(constraintKey)) {
            seen.add(constraintKey);
            constraints.push({ key: normalizedKey, value: value.toLowerCase().trim() });
          }
        }
      }
    }
    
    // Pattern 2: {key}-{value} or {key}:{value} where key is discovered option name
    for (const optionName of discoveredOptionNames) {
      const prefix1 = `${optionName}-`;
      const prefix2 = `${optionName}:`;
      
      if (tag.startsWith(prefix1)) {
        const value = tag.substring(prefix1.length);
        const constraintKey = `${optionName}:${value}`;
        if (!seen.has(constraintKey) && value.trim().length > 0) {
          seen.add(constraintKey);
          constraints.push({ key: optionName, value: value.toLowerCase().trim() });
        }
      } else if (tag.startsWith(prefix2)) {
        const value = tag.substring(prefix2.length);
        const constraintKey = `${optionName}:${value}`;
        if (!seen.has(constraintKey) && value.trim().length > 0) {
          seen.add(constraintKey);
          constraints.push({ key: optionName, value: value.toLowerCase().trim() });
        }
      }
    }
  }
  
  return constraints;
}

/**
 * Merchant-configurable facet mapping
 */
export interface FacetMappingConfig {
  preferredOptionNameAliases?: Record<string, string>; // e.g., { "colour": "color" }
  metafieldKeysForConstraints?: string[]; // Optional metafield keys to check for constraints
  tagPrefixesEnabled?: boolean; // Whether to use tag adapters (default: true)
}

/**
 * Apply merchant config to normalize option names
 */
export function applyFacetMapping(
  optionName: string,
  config?: FacetMappingConfig
): string {
  let normalized = normalizeOptionName(optionName);
  
  // Apply merchant-specific aliases
  if (config?.preferredOptionNameAliases) {
    const alias = config.preferredOptionNameAliases[normalized];
    if (alias) {
      normalized = normalizeOptionName(alias);
    }
  }
  
  return normalized;
}

/**
 * Convert old hardFacets format to generic constraints array
 * Keeps backward compatibility
 */
export function convertHardFacetsToConstraints(
  hardFacets: { size: string | null; color: string | null; material: string | null },
  scope?: "global" | "item"
): FacetConstraint[] {
  const constraints: FacetConstraint[] = [];
  
  if (hardFacets.size) {
    constraints.push({ key: "size", value: hardFacets.size, scope });
  }
  if (hardFacets.color) {
    constraints.push({ key: "color", value: hardFacets.color, scope });
  }
  if (hardFacets.material) {
    constraints.push({ key: "material", value: hardFacets.material, scope });
  }
  
  return constraints;
}

/**
 * Convert old optionConstraints format to generic constraints array
 */
export function convertOptionConstraintsToConstraints(
  optionConstraints: { size?: string | null; color?: string | null; material?: string | null },
  scope?: "global" | "item"
): FacetConstraint[] {
  return convertHardFacetsToConstraints({
    size: optionConstraints.size ?? null,
    color: optionConstraints.color ?? null,
    material: optionConstraints.material ?? null,
  }, scope);
}

/**
 * Merge global and item constraints (item overrides global)
 */
export function mergeConstraints(
  globalConstraints: FacetConstraint[],
  itemConstraints: FacetConstraint[]
): FacetConstraint[] {
  const merged = new Map<string, FacetConstraint>();
  
  // Add global constraints first
  for (const constraint of globalConstraints) {
    const key = normalizeOptionName(constraint.key);
    merged.set(key, { ...constraint, scope: "global" });
  }
  
  // Override with item constraints
  for (const constraint of itemConstraints) {
    const key = normalizeOptionName(constraint.key);
    merged.set(key, { ...constraint, scope: "item" });
  }
  
  return Array.from(merged.values());
}

/**
 * Determine constraint scope from user intent
 * If user says "in large" and doesn't attach it to a specific item, treat as scope=global
 * If user says "shirt in large", scope=item
 */
export function determineConstraintScope(
  constraintValue: string,
  userIntent: string,
  itemHardTerms: string[]
): "global" | "item" {
  const lowerIntent = userIntent.toLowerCase();
  const lowerValue = constraintValue.toLowerCase();
  
  // Check if constraint is attached to specific item terms
  for (const term of itemHardTerms) {
    const lowerTerm = term.toLowerCase();
    // Pattern: "{term} in {value}" or "{term} {value}"
    const itemPattern1 = new RegExp(`\\b${lowerTerm}\\s+(?:in\\s+)?${lowerValue}\\b`, "i");
    const itemPattern2 = new RegExp(`\\b${lowerValue}\\s+${lowerTerm}\\b`, "i");
    
    if (itemPattern1.test(lowerIntent) || itemPattern2.test(lowerIntent)) {
      return "item";
    }
  }
  
  // Check if constraint appears after listing multiple items (global pattern)
  // Pattern: "item1, item2 and item3 in {value}"
  const globalPattern = new RegExp(`(?:,|and|or)\\s+[^,]+\\s+(?:in\\s+)?${lowerValue}\\b`, "i");
  if (globalPattern.test(lowerIntent)) {
    return "global";
  }
  
  // Default: if constraint appears at end of query without item attachment, assume global
  const endPattern = new RegExp(`(?:in\\s+)?${lowerValue}\\s*$`, "i");
  if (endPattern.test(lowerIntent.trim())) {
    return "global";
  }
  
  return "item"; // Conservative default
}

/**
 * Relax constraints with staged fallback
 * Stage 1: relax least important constraint (size before color IF size not found in shop's option names; otherwise relax soft terms first)
 * Stage 2: keep anchor terms only
 */
export function relaxConstraints(
  constraints: FacetConstraint[],
  discoveredOptionNames: Set<string>,
  stage: 1 | 2
): {
  relaxed: FacetConstraint[];
  removed: FacetConstraint[];
  reason: string;
} {
  if (stage === 1) {
    // Stage 1: Remove least important constraint
    // Priority: size (if not in discovered options) > material > color > others
    const sizeKey = Array.from(discoveredOptionNames).find(n => normalizeOptionName(n) === "size");
    const materialKey = Array.from(discoveredOptionNames).find(n => normalizeOptionName(n) === "material");
    const colorKey = Array.from(discoveredOptionNames).find(n => normalizeOptionName(n) === "color");
    
    // Find constraint to remove (prefer size if not in discovered options, otherwise material, then color)
    let toRemove: FacetConstraint | null = null;
    let reason = "";
    
    if (!sizeKey) {
      // Size not in shop's options - remove size constraint first
      toRemove = constraints.find(c => normalizeOptionName(c.key) === "size") || null;
      reason = "size_not_in_shop_options";
    } else if (materialKey) {
      // Material is in shop's options - remove material before color
      toRemove = constraints.find(c => normalizeOptionName(c.key) === "material") || null;
      reason = "material_relaxed_stage1";
    } else if (colorKey) {
      // Only color constraint - remove it
      toRemove = constraints.find(c => normalizeOptionName(c.key) === "color") || null;
      reason = "color_relaxed_stage1";
    } else {
      // Remove first constraint (any)
      toRemove = constraints[0] || null;
      reason = "first_constraint_relaxed_stage1";
    }
    
    if (toRemove) {
      const relaxed = constraints.filter(c => c !== toRemove);
      return { relaxed, removed: [toRemove], reason };
    }
  }
  
  // Stage 2: Remove all constraints (keep anchor terms only)
  return {
    relaxed: [],
    removed: constraints,
    reason: "all_constraints_relaxed_stage2"
  };
}

