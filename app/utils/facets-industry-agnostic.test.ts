/**
 * Tests for industry-agnostic facet system
 * Tests non-fashion industries (beauty, home, etc.)
 */

import { describe, test, expect } from "vitest";
import {
  discoverFacetVocabulary,
  variantSatisfiesConstraints,
  productSatisfiesConstraints,
  convertHardFacetsToConstraints,
  convertOptionConstraintsToConstraints,
  mergeConstraints,
  relaxConstraints,
  extractConstraintsFromTags,
  FacetConstraint,
} from "./facets.server";

describe("Facet Discovery - Non-Fashion Industries", () => {
  test("should discover beauty product facets (Scent, Finish, Shade)", () => {
    const candidates = [
      {
        variants: [
          {
            selectedOptions: [
              { name: "Scent", value: "Vanilla" },
              { name: "Capacity", value: "200ml" },
            ],
          },
          {
            selectedOptions: [
              { name: "Scent", value: "Lavender" },
              { name: "Capacity", value: "200ml" },
            ],
          },
        ],
      },
      {
        variants: [
          {
            selectedOptions: [
              { name: "Shade", value: "Ruby" },
              { name: "Finish", value: "Matte" },
            ],
          },
        ],
      },
    ];

    const vocabulary = discoverFacetVocabulary(candidates as any);
    
    expect(vocabulary.optionNames.has("scent")).toBe(true);
    expect(vocabulary.optionNames.has("capacity")).toBe(true);
    expect(vocabulary.optionNames.has("shade")).toBe(true);
    expect(vocabulary.optionNames.has("finish")).toBe(true);
    
    expect(vocabulary.optionNameToValues.get("scent")?.has("vanilla")).toBe(true);
    expect(vocabulary.optionNameToValues.get("scent")?.has("lavender")).toBe(true);
    expect(vocabulary.optionNameToValues.get("capacity")?.has("200ml")).toBe(true);
    expect(vocabulary.optionNameToValues.get("shade")?.has("ruby")).toBe(true);
    expect(vocabulary.optionNameToValues.get("finish")?.has("matte")).toBe(true);
  });

  test("should discover home goods facets (Material, Length, Capacity)", () => {
    const candidates = [
      {
        variants: [
          {
            selectedOptions: [
              { name: "Material", value: "Velvet" },
              { name: "Length", value: "84 inches" },
            ],
          },
        ],
      },
      {
        optionValues: {
          Capacity: ["500ml", "1L"],
          Material: ["Cotton", "Linen"],
        },
      },
    ];

    const vocabulary = discoverFacetVocabulary(candidates as any);
    
    expect(vocabulary.optionNames.has("material")).toBe(true);
    expect(vocabulary.optionNames.has("length")).toBe(true);
    expect(vocabulary.optionNames.has("capacity")).toBe(true);
  });
});

describe("Constraint Matching - Non-Fashion", () => {
  test('"vanilla candle in 200ml" should match via Scent and Capacity constraints', () => {
    const variant = {
      selectedOptions: [
        { name: "Scent", value: "Vanilla" },
        { name: "Capacity", value: "200ml" },
      ],
    };

    const constraints: FacetConstraint[] = [
      { key: "scent", value: "vanilla", scope: "item" },
      { key: "capacity", value: "200ml", scope: "item" },
    ];

    expect(variantSatisfiesConstraints(variant, constraints)).toBe(true);
  });

  test('"matte lipstick in shade ruby" should match via Finish and Shade constraints', () => {
    const variant = {
      selectedOptions: [
        { name: "Shade", value: "Ruby" },
        { name: "Finish", value: "Matte" },
      ],
    };

    const constraints: FacetConstraint[] = [
      { key: "shade", value: "ruby", scope: "item" },
      { key: "finish", value: "matte", scope: "item" },
    ];

    expect(variantSatisfiesConstraints(variant, constraints)).toBe(true);
  });

  test('"sofa in velvet" should match via Material constraint', () => {
    const product = {
      available: true,
      variants: [
        {
          selectedOptions: [{ name: "Material", value: "Velvet" }],
          availableForSale: true,
        },
      ],
    };

    const constraints: FacetConstraint[] = [
      { key: "material", value: "velvet", scope: "item" },
    ];

    expect(productSatisfiesConstraints(product, constraints, true)).toBe(true);
  });

  test("should fail when constraint doesn't match", () => {
    const variant = {
      selectedOptions: [
        { name: "Scent", value: "Vanilla" },
        { name: "Capacity", value: "200ml" },
      ],
    };

    const constraints: FacetConstraint[] = [
      { key: "scent", value: "lavender", scope: "item" }, // Different scent
    ];

    expect(variantSatisfiesConstraints(variant, constraints)).toBe(false);
  });
});

describe("Bundle Constraints - Global Size Application", () => {
  test('"black suit, black trousers and white shirt in large" - global size should apply to all items', () => {
    const globalConstraints = convertHardFacetsToConstraints(
      { size: "large", color: null, material: null },
      "global"
    );
    
    const shirtConstraints = convertOptionConstraintsToConstraints(
      { size: null, color: "white", material: null },
      "item"
    );
    
    const merged = mergeConstraints(globalConstraints, shirtConstraints);
    
    // Should have size from global and color from item
    expect(merged.find(c => c.key === "size")?.value).toBe("large");
    expect(merged.find(c => c.key === "size")?.scope).toBe("global");
    expect(merged.find(c => c.key === "color")?.value).toBe("white");
    expect(merged.find(c => c.key === "color")?.scope).toBe("item");
  });

  test("item constraints should override global constraints", () => {
    const globalConstraints = convertHardFacetsToConstraints(
      { size: "large", color: "black", material: null },
      "global"
    );
    
    const itemConstraints = convertOptionConstraintsToConstraints(
      { size: "medium", color: "white", material: null },
      "item"
    );
    
    const merged = mergeConstraints(globalConstraints, itemConstraints);
    
    // Item should override global
    expect(merged.find(c => c.key === "size")?.value).toBe("medium");
    expect(merged.find(c => c.key === "size")?.scope).toBe("item");
    expect(merged.find(c => c.key === "color")?.value).toBe("white");
    expect(merged.find(c => c.key === "color")?.scope).toBe("item");
  });
});

describe("Staged Fallback - Constraint Relaxation", () => {
  test("should relax size constraint first if size not in shop options", () => {
    const constraints: FacetConstraint[] = [
      { key: "size", value: "large", scope: "item" },
      { key: "color", value: "red", scope: "item" },
      { key: "material", value: "cotton", scope: "item" },
    ];

    const discoveredOptions = new Set<string>(["color", "material"]); // No "size"

    const stage1 = relaxConstraints(constraints, discoveredOptions, 1);
    
    expect(stage1.removed.length).toBe(1);
    expect(stage1.removed[0].key).toBe("size");
    expect(stage1.reason).toBe("size_not_in_shop_options");
    expect(stage1.relaxed.length).toBe(2);
  });

  test("should relax material before color if both are in shop options", () => {
    const constraints: FacetConstraint[] = [
      { key: "size", value: "large", scope: "item" },
      { key: "color", value: "red", scope: "item" },
      { key: "material", value: "cotton", scope: "item" },
    ];

    const discoveredOptions = new Set<string>(["size", "color", "material"]);

    const stage1 = relaxConstraints(constraints, discoveredOptions, 1);
    
    expect(stage1.removed.length).toBe(1);
    expect(stage1.removed[0].key).toBe("material");
    expect(stage1.reason).toBe("material_relaxed_stage1");
  });

  test("stage 2 should remove all constraints", () => {
    const constraints: FacetConstraint[] = [
      { key: "size", value: "large", scope: "item" },
      { key: "color", value: "red", scope: "item" },
    ];

    const discoveredOptions = new Set<string>(["size", "color"]);

    const stage2 = relaxConstraints(constraints, discoveredOptions, 2);
    
    expect(stage2.removed.length).toBe(2);
    expect(stage2.relaxed.length).toBe(0);
    expect(stage2.reason).toBe("all_constraints_relaxed_stage2");
  });
});

describe("Tag Adapter - Optional Fallback", () => {
  test("should extract constraints from cf-* tags when option names discovered", () => {
    const tags = ["cf-size-large", "cf-color-red", "cf-capacity-200ml"];
    const discoveredOptions = new Set<string>(["size", "color", "capacity"]);

    const constraints = extractConstraintsFromTags(tags, discoveredOptions);
    
    expect(constraints.length).toBe(3);
    expect(constraints.find(c => c.key === "size")?.value).toBe("large");
    expect(constraints.find(c => c.key === "color")?.value).toBe("red");
    expect(constraints.find(c => c.key === "capacity")?.value).toBe("200ml");
  });

  test("should ignore tags for non-discovered options", () => {
    const tags = ["cf-size-large", "cf-unknown-123"];
    const discoveredOptions = new Set<string>(["size"]);

    const constraints = extractConstraintsFromTags(tags, discoveredOptions);
    
    expect(constraints.length).toBe(1);
    expect(constraints[0].key).toBe("size");
  });
});

describe("Value Matching - Size Equivalences", () => {
  test('"large" should match "l" via equivalence', () => {
    const variant1 = {
      selectedOptions: [{ name: "Size", value: "Large" }],
    };
    const variant2 = {
      selectedOptions: [{ name: "Size", value: "L" }],
    };

    const constraints: FacetConstraint[] = [
      { key: "size", value: "large", scope: "item" },
    ];

    expect(variantSatisfiesConstraints(variant1, constraints)).toBe(true);
    expect(variantSatisfiesConstraints(variant2, constraints)).toBe(true);
  });

  test('"xl" should match "extra large" via equivalence', () => {
    const variant = {
      selectedOptions: [{ name: "Size", value: "Extra Large" }],
    };

    const constraints: FacetConstraint[] = [
      { key: "size", value: "xl", scope: "item" },
    ];

    expect(variantSatisfiesConstraints(variant, constraints)).toBe(true);
  });
});

