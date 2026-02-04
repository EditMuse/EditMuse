import { describe, test, expect } from "vitest";
import { parseSizeTags, parseMaterialTags } from "../shopify-admin.server";

describe("parseSizeTags", () => {
  test("should parse cf-size-* tags and return lowercase values", () => {
    const tags = ["cf-size-m", "cf-size-l", "cf-size-xl"];
    const sizes = parseSizeTags(tags);
    expect(sizes).toEqual(["m", "l", "xl"]);
  });

  test("should handle mixed case tags", () => {
    const tags = ["cf-size-M", "cf-size-L", "CF-SIZE-XL"];
    const sizes = parseSizeTags(tags);
    expect(sizes).toEqual(["m", "l", "xl"]);
  });

  test("should ignore non-size tags", () => {
    const tags = ["cf-size-m", "cf-color-blue", "cf-material-cotton", "other-tag"];
    const sizes = parseSizeTags(tags);
    expect(sizes).toEqual(["m"]);
  });

  test("should handle empty tags array", () => {
    const sizes = parseSizeTags([]);
    expect(sizes).toEqual([]);
  });

  test("should handle tags with extra spaces", () => {
    const tags = ["cf-size- m ", "cf-size-  l  "];
    const sizes = parseSizeTags(tags);
    expect(sizes).toEqual(["m", "l"]);
  });

  test("should dedupe sizes", () => {
    const tags = ["cf-size-m", "cf-size-m", "cf-size-l"];
    const sizes = parseSizeTags(tags);
    expect(sizes).toEqual(["m", "l"]);
  });
});

describe("parseMaterialTags", () => {
  test("should parse simple cf-material-* tags", () => {
    const tags = ["cf-material-cotton"];
    const materials = parseMaterialTags(tags);
    expect(materials).toEqual(["cotton"]);
  });

  test("should parse composite material tags and split into tokens", () => {
    const tags = ["cf-material-80-cotton-20-polyester"];
    const materials = parseMaterialTags(tags);
    expect(materials).toEqual(["cotton", "polyester"]);
  });

  test("should remove numeric percentages", () => {
    const tags = ["cf-material-60-cotton-40-polyester"];
    const materials = parseMaterialTags(tags);
    expect(materials).toEqual(["cotton", "polyester"]);
  });

  test("should handle multiple material tags", () => {
    const tags = ["cf-material-cotton", "cf-material-wool"];
    const materials = parseMaterialTags(tags);
    expect(materials).toEqual(["cotton", "wool"]);
  });

  test("should handle complex material compositions", () => {
    const tags = ["cf-material-50-cotton-30-polyester-20-spandex"];
    const materials = parseMaterialTags(tags);
    expect(materials).toEqual(["cotton", "polyester", "spandex"]);
  });

  test("should ignore non-material tags", () => {
    const tags = ["cf-material-cotton", "cf-size-m", "cf-color-blue"];
    const materials = parseMaterialTags(tags);
    expect(materials).toEqual(["cotton"]);
  });

  test("should handle empty tags array", () => {
    const materials = parseMaterialTags([]);
    expect(materials).toEqual([]);
  });

  test("should dedupe materials", () => {
    const tags = ["cf-material-cotton", "cf-material-cotton", "cf-material-wool"];
    const materials = parseMaterialTags(tags);
    expect(materials).toEqual(["cotton", "wool"]);
  });

  test("should handle tags with trailing percentages", () => {
    const tags = ["cf-material-cotton-80-polyester-20"];
    const materials = parseMaterialTags(tags);
    expect(materials).toEqual(["cotton", "polyester"]);
  });
});

