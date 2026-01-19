/**
 * Helper functions for making Shopify Admin API calls using shop access tokens
 */

import prisma from "~/db.server";
import { cleanDescription } from "~/utils/text-indexing.server";

/**
 * Gets access token from Session table for a shop domain
 */
export async function getAccessTokenForShop(shopDomain: string): Promise<string | null> {
  const session = await prisma.session.findFirst({
    where: {
      shop: shopDomain,
      accessToken: { not: "" },
    },
    orderBy: { expires: "desc" },
  });

  return session?.accessToken || null;
}

/**
 * Gets offline access token from Session table for a shop domain
 */
export async function getOfflineAccessTokenForShop(shopDomain: string): Promise<string | null> {
  const session = await prisma.session.findFirst({
    where: {
      shop: shopDomain,
      isOnline: false,
      accessToken: { not: "" },
    },
    orderBy: { expires: "desc" },
  });

  return session?.accessToken || null;
}

/**
 * Normalize string value
 */
function normStr(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const t = s.trim();
  return t.length ? t : null;
}

/**
 * Get unique lowercase values
 */
function uniqLower(values: (string | null | undefined)[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of values) {
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

/**
 * Classify option name as size, color, or material
 */
function classifyOptionName(name: string | null): "size" | "color" | "material" | null {
  if (!name) return null;
  const n = name.toLowerCase();

  // Size signals
  if (/(size|sizes|sizing)/.test(n)) return "size";

  // Color signals
  if (/(color|colour|shade|tone)/.test(n)) return "color";

  // Material signals
  if (/(material|fabric|composition)/.test(n)) return "material";

  return null;
}

/**
 * Extract variant facet values (sizes, colors, materials) from product
 */
function extractVariantFacetValues(product: any): {
  sizes: string[];
  colors: string[];
  materials: string[];
} {
  const options = Array.isArray(product?.options) ? product.options : [];
  const variants = Array.isArray(product?.variants) ? product.variants : [];

  // Map option position -> facet type (size/color/material) using product.options
  // Shopify REST: product.options = [{ name, position, values }]
  const positionToFacet = new Map<number, "size" | "color" | "material">();
  for (const opt of options) {
    const facet = classifyOptionName(normStr(opt?.name));
    const pos = typeof opt?.position === "number" ? opt.position : null;
    if (facet && pos) positionToFacet.set(pos, facet);
  }

  // Pull values from variants option1/2/3
  const sizes: (string | null)[] = [];
  const colors: (string | null)[] = [];
  const materials: (string | null)[] = [];

  for (const v of variants) {
    const o1 = normStr(v?.option1);
    const o2 = normStr(v?.option2);
    const o3 = normStr(v?.option3);

    const pairs: Array<[number, string | null]> = [
      [1, o1],
      [2, o2],
      [3, o3],
    ];

    for (const [pos, val] of pairs) {
      const facet = positionToFacet.get(pos);
      if (!facet || !val) continue;
      if (facet === "size") sizes.push(val);
      if (facet === "color") colors.push(val);
      if (facet === "material") materials.push(val);
    }
  }

  // If product.options exists but names are generic (Option 1), we still try best-effort:
  // If a product has exactly one option and its name is "Size" missing — already handled.
  // Otherwise we keep it empty rather than guessing wrong.

  return {
    sizes: uniqLower(sizes),
    colors: uniqLower(colors),
    materials: uniqLower(materials),
  };
}

/**
 * Extract generic option values from product (all option names -> values)
 */
function extractOptionValues(product: any): Record<string, string[]> {
  const options = Array.isArray(product?.options) ? product.options : [];
  const variants = Array.isArray(product?.variants) ? product.variants : [];

  // Map option position -> option name (Shopify REST: position is 1-based)
  const positionToName = new Map<number, string>();
  for (const opt of options) {
    const name = normStr(opt?.name);
    const pos = typeof opt?.position === "number" ? opt.position : null;
    if (name && pos) positionToName.set(pos, name);
  }

  const map: Record<string, string[]> = {};

  function push(name: string, value: string | null) {
    if (!value) return;
    map[name] ??= [];
    map[name].push(value);
  }

  for (const v of variants) {
    const o1 = normStr(v?.option1);
    const o2 = normStr(v?.option2);
    const o3 = normStr(v?.option3);

    const pairs: Array<[number, string | null]> = [
      [1, o1],
      [2, o2],
      [3, o3],
    ];

    for (const [pos, val] of pairs) {
      const name = positionToName.get(pos);
      if (!name) continue;
      push(name, val);
    }
  }

  // de-dupe (case-insensitive), preserve original casing
  const out: Record<string, string[]> = {};
  for (const [k, arr] of Object.entries(map)) {
    out[k] = uniqLower(arr);
  }
  return out;
}

/**
 * Computes product availability from variant data (REST API safe)
 * Handles cases where inventory_quantity may be missing
 */
function computeAvailabilityFromVariants(variants: any[] | undefined): boolean {
  if (!variants || variants.length === 0) return true;

  // If any variant allows continue-selling when out of stock, treat as available.
  if (variants.some(v => String(v?.inventory_policy).toLowerCase() === "continue")) {
    return true;
  }

  // If we have inventory quantities, use them.
  const hasAnyQty = variants.some(v => typeof v?.inventory_quantity === "number");
  if (hasAnyQty) {
    return variants.some(v => (typeof v?.inventory_quantity === "number") && v.inventory_quantity > 0);
  }

  // If inventory quantities are missing entirely, we can't know; default to "available"
  // so we don't accidentally hide products.
  return true;
}

/**
 * Helper to extract next page URL from Shopify REST API Link header
 */
function getNextUrlFromLinkHeader(linkHeader: string | null): string | null {
  if (!linkHeader) return null;

  // Shopify REST pagination returns Link header:
  // <https://.../products.json?limit=250&page_info=XYZ>; rel="next"
  const parts = linkHeader.split(",");
  for (const part of parts) {
    const section = part.trim();
    const match = section.match(/<([^>]+)>\s*;\s*rel="next"/i);
    if (match?.[1]) return match[1];
  }
  return null;
}

/**
 * Helper to fetch paginated data from Shopify REST API
 */
async function fetchRestPaged<T = any>(
  firstUrl: string,
  accessToken: string,
  maxItems: number
): Promise<T[]> {
  const out: T[] = [];
  let url: string | null = firstUrl;

  while (url && out.length < maxItems) {
    const response = await fetch(url, {
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
      redirect: "manual", // Don't follow redirects automatically
    });

    // Check for redirect to password page (common with password-protected stores)
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (location && location.includes("/password")) {
        throw new Error(
          `Request redirected to password page. This usually means:\n` +
          `1. The access token is invalid or expired\n` +
          `2. The shopDomain "${url.match(/https:\/\/([^/]+)/)?.[1]}" is incorrect\n` +
          `3. The app needs to be reinstalled. Admin API should not require storefront password.`
        );
      }
    }

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      throw new Error(
        `Shopify API error: ${response.status} ${response.statusText}\n` +
        `URL: ${url}\n` +
        `Response: ${errorBody.substring(0, 500)}`
      );
    }

    const data = await response.json();
    const items: T[] = (data?.products || []) as T[];

    out.push(...items);
    if (out.length >= maxItems) break;

    const link = response.headers.get("link");
    url = getNextUrlFromLinkHeader(link);
  }

  return out.slice(0, maxItems);
}

/**
 * Fetches products from Shopify Admin API using shop access token
 */
export async function fetchShopifyProducts({
  shopDomain,
  accessToken,
  limit = 50,
  collectionIds,
}: {
  shopDomain: string;
  accessToken: string;
  limit?: number;
  collectionIds?: string[];
}): Promise<Array<{
  handle: string;
  title: string;
  image: string | null;
  price: string | null;
  priceAmount: string | null;
  currencyCode: string | null;
  tags: string[];
  available: boolean;
  status: string | null;
}>> {
  // Try GraphQL first (primary)
  try {
    console.log("[Shopify Fetch] Using GraphQL (primary)");
    const graphqlProducts = await fetchShopifyProductsGraphQL({
      shopDomain,
      accessToken,
      limit,
      collectionIds,
    });
    
    // Map GraphQL products to expected shape
    return graphqlProducts.map(p => ({
      handle: p.handle,
      title: p.title,
      image: p.image,
      price: p.price,
      priceAmount: p.priceAmount,
      currencyCode: p.currencyCode,
      tags: p.tags,
      available: p.available,
      status: p.status,
      // GraphQL provides these additional fields
      url: p.url,
      productType: p.productType,
      vendor: p.vendor,
      description: p.description,
    } as any));
  } catch (error) {
    // Fallback to REST on GraphQL error
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.log("[Shopify Fetch] GraphQL failed, falling back to REST:", errorMessage);
    
    // REST fallback implementation
    const apiVersion = "2025-01";
    // Include richer fields to match GraphQL output
    const fields = "id,title,handle,images,variants,options,tags,status,product_type,vendor,body_html";
    
    // If collectionIds provided, fetch from collections, otherwise fetch all products
    let products: any[] = [];
    
    if (collectionIds && collectionIds.length > 0) {
      // Fetch products from each collection and merge
      const allProducts = new Map<string, any>();
      
      for (const collectionId of collectionIds) {
        if (allProducts.size >= limit) break;

        try {
          const url = `https://${shopDomain}/admin/api/${apiVersion}/collections/${collectionId}/products.json?limit=250&fields=${fields}`;

          const remaining = limit - allProducts.size;
          const fetched = await fetchRestPaged<any>(url, accessToken, remaining);

          for (const p of fetched) allProducts.set(p.id, p);
        } catch (error) {
          console.error(`[Shopify Admin] Error fetching collection ${collectionId}:`, error);
        }
      }
      
      products = Array.from(allProducts.values());
    } else {
      // Fetch all products with pagination
      const baseUrl = `https://${shopDomain}/admin/api/${apiVersion}/products.json?limit=250&fields=${fields}`;
      products = await fetchRestPaged<any>(baseUrl, accessToken, limit);
    }

    const mapped = products.map((product: any) => {
      const variants = Array.isArray(product.variants) ? product.variants : [];
      
      // Price calculation: compute min price across variants
      let priceAmount: string | null = null;
      if (variants.length > 0) {
        const prices = variants
          .map((v: any) => {
            const priceStr = v?.price;
            if (typeof priceStr === "string") {
              const parsed = parseFloat(priceStr);
              return isNaN(parsed) ? null : parsed;
            }
            return null;
          })
          .filter((p: number | null): p is number => p !== null);
        
        if (prices.length > 0) {
          const min = Math.min(...prices);
          priceAmount = isFinite(min) ? min.toFixed(2) : null;
        }
      }
      
      // Availability calculation: check inventory_quantity, fallback to status ACTIVE
      let available = false;
      if (variants.length > 0) {
        // Check if any variant has inventory_quantity > 0
        available = variants.some((v: any) => (v.inventory_quantity ?? 0) > 0);
        
        // If inventory_quantity is null/undefined for all variants, fallback to status check
        if (!available && variants.every((v: any) => v.inventory_quantity === null || v.inventory_quantity === undefined)) {
          available = product.status === "ACTIVE";
        }
      } else {
        // No variants: use status as fallback
        available = product.status === "ACTIVE";
      }
      
      // Clean description from body_html
      const description = product.body_html ? cleanDescription(product.body_html) : null;
      
      // Extract optionValues and facet arrays from variants (REST fallback)
      const facets = extractVariantFacetValues(product);
      const optionValues = extractOptionValues(product);
      
      return {
        handle: product.handle,
        title: product.title,
        image: product.images?.[0]?.src || null,
        price: priceAmount, // Keep for backwards compatibility
        priceAmount: priceAmount,
        currencyCode: null, // REST API doesn't provide currency code
        url: `/products/${product.handle}`,
        tags: product.tags ? product.tags.split(",").map((t: string) => t.trim()) : [],
        available: available,
        productType: product.product_type || null,
        vendor: product.vendor || null,
        description: description,
        status: product.status || null,
        // Extract option intelligence from variants (REST fallback)
        optionValues: optionValues,
        sizes: facets.sizes,
        colors: facets.colors,
        materials: facets.materials,
        // Preserve variants for downstream processing
        variants: variants,
      } as any;
    });
    
    // Log REST fallback mapping stats
    const totalVariants = mapped.reduce((sum, p) => sum + ((p as any).variants?.length || 0), 0);
    const withDescription = mapped.filter(p => p.description).length;
    const withProductType = mapped.filter(p => p.productType).length;
    const withVendor = mapped.filter(p => p.vendor).length;
    console.log("[Shopify Fetch] REST fallback products mapped", {
      count: mapped.length,
      withDescription,
      withProductType,
      withVendor,
      totalVariants,
    });
    
    return mapped;
  }
}

/**
 * Fetches products from Shopify Admin GraphQL API
 * Supports collection filtering and returns tags for filtering
 */
export async function fetchShopifyProductsGraphQL({
  shopDomain,
  accessToken,
  limit = 50,
  collectionIds,
}: {
  shopDomain: string;
  accessToken: string;
  limit?: number;
  collectionIds?: string[];
}): Promise<Array<{
  handle: string;
  title: string;
  image: string | null;
  price: string | null;
  priceAmount: string | null;
  currencyCode: string | null;
  url: string;
  tags: string[];
  available: boolean;
  productType: string | null;
  vendor: string | null;
  description: string | null;
  status: string | null;
}>> {
  const apiVersion = "2025-01";
  const url = `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`;

  // Build query based on whether we're filtering by collections
  let query: string;
  let variables: any;

  const TARGET_COUNT = limit;
  const PAGE_SIZE = 250; // Shopify max per page
  let allProducts: any[] = [];
  let hasNextPage = true;
  let cursor: string | null = null;

  if (collectionIds && collectionIds.length > 0) {
    // Query products from specific collections with cursor pagination
    // Note: GraphQL Admin API uses collection IDs in format "gid://shopify/Collection/123"
    const graphqlCollectionIds = collectionIds.map(id => {
      if (id.startsWith("gid://")) {
        return id;
      }
      return `gid://shopify/Collection/${id}`;
    });
    
    // Paginate through each collection
    for (const collectionId of graphqlCollectionIds) {
      hasNextPage = true;
      cursor = null;
      
      while (hasNextPage && allProducts.length < TARGET_COUNT) {
        const pageSize = Math.min(PAGE_SIZE, TARGET_COUNT - allProducts.length);
        
        query = `
          query getProductsFromCollection($id: ID!, $first: Int!, $after: String) {
            node(id: $id) {
              ... on Collection {
                id
                products(first: $first, after: $after) {
                  pageInfo {
                    hasNextPage
                    endCursor
                  }
                  edges {
                    node {
                      handle
                      title
                      featuredImage {
                        url
                      }
                      priceRange {
                        minVariantPrice {
                          amount
                          currencyCode
                        }
                      }
                      onlineStoreUrl
                      tags
                      totalInventory
                      productType
                      vendor
                      description
                      status
                      options {
                        name
                        values
                      }
                      variants(first: 1) {
                        edges {
                          node {
                            inventoryPolicy
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        `;
        
        variables = { 
          id: collectionId,
          first: pageSize,
          after: cursor
        };
        
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "X-Shopify-Access-Token": accessToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            query,
            variables,
          }),
          redirect: "manual",
        });

        // Check for redirect to password page
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          if (location && location.includes("/password")) {
            throw new Error(
              `Request redirected to password page. This usually means:\n` +
              `1. The access token is invalid or expired\n` +
              `2. The shopDomain "${shopDomain}" is incorrect\n` +
              `3. The app needs to be reinstalled. Admin API should not require storefront password.`
            );
          }
        }

        if (!response.ok) {
          const errorBody = await response.text().catch(() => "");
          throw new Error(
            `Shopify GraphQL API error: ${response.status} ${response.statusText}\n` +
            `URL: ${url}\n` +
            `Response: ${errorBody.substring(0, 500)}`
          );
        }

        const data = await response.json();

        if (data.errors) {
          throw new Error(`Shopify GraphQL errors: ${JSON.stringify(data.errors)}`);
        }

        const collection = data.data?.node;
        if (collection?.products?.edges) {
          const pageProducts = collection.products.edges.map((edge: any) => edge.node);
          // Deduplicate by handle
          for (const product of pageProducts) {
            if (!allProducts.find(p => p.handle === product.handle)) {
              allProducts.push(product);
            }
          }
          
          const pageInfo = collection.products.pageInfo;
          hasNextPage = pageInfo?.hasNextPage || false;
          cursor = pageInfo?.endCursor || null;
        } else {
          hasNextPage = false;
        }
      }
    }
  } else {
    // Query all products with cursor pagination
    while (hasNextPage && allProducts.length < TARGET_COUNT) {
      const pageSize = Math.min(PAGE_SIZE, TARGET_COUNT - allProducts.length);
      
      query = `
        query getProducts($first: Int!, $after: String) {
          products(first: $first, after: $after, sortKey: CREATED_AT, reverse: true) {
            pageInfo {
              hasNextPage
              endCursor
            }
            edges {
              node {
                handle
                title
                featuredImage {
                  url
                }
                priceRange {
                  minVariantPrice {
                    amount
                    currencyCode
                  }
                }
                onlineStoreUrl
                tags
                totalInventory
                productType
                vendor
                description
                status
                options {
                  name
                  values
                }
                variants(first: 1) {
                  edges {
                    node {
                      inventoryPolicy
                    }
                  }
                }
              }
            }
          }
        }
      `;
      
      variables = { 
        first: pageSize,
        after: cursor
      };
      
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": accessToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query,
          variables,
        }),
        redirect: "manual",
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => "");
        throw new Error(
          `Shopify GraphQL API error: ${response.status} ${response.statusText}\n` +
          `URL: ${url}\n` +
          `Response: ${errorBody.substring(0, 500)}`
        );
      }

      const data = await response.json();

      if (data.errors) {
        throw new Error(`Shopify GraphQL errors: ${JSON.stringify(data.errors)}`);
      }

      const productsData = data.data?.products;
      if (productsData?.edges) {
        const pageProducts = productsData.edges.map((edge: any) => edge.node);
        allProducts.push(...pageProducts);
        
        const pageInfo = productsData.pageInfo;
        hasNextPage = pageInfo?.hasNextPage || false;
        cursor = pageInfo?.endCursor || null;
      } else {
        hasNextPage = false;
      }
    }
  }

  // Products are now collected in allProducts array from pagination loop above
  const products = allProducts.slice(0, TARGET_COUNT);
  
  console.log("[Shopify Fetch] GraphQL paginated", {
    totalFetched: products.length,
    targetCount: TARGET_COUNT,
    hadMorePages: hasNextPage && products.length >= TARGET_COUNT,
  });

  const mapped = products.map((node: any) => {
    const priceData = node.priceRange?.minVariantPrice;
    const rawAmount = priceData?.amount || null;
    const currencyCode = priceData?.currencyCode || null;
    
    // Convert price to major units if needed
    // Shopify GraphQL Admin API should return prices in major units, but handle edge cases
    // where prices might be in cents (e.g., "74995.0" should become "749.95")
    let priceAmount: string | null = null;
    if (rawAmount !== null) {
      const numAmount = parseFloat(rawAmount);
      // Heuristic: if amount > 10000, almost certainly in cents
      // If amount between 1000-10000, check if dividing by 100 gives reasonable value (< 1000)
      if (numAmount > 10000) {
        priceAmount = (numAmount / 100).toFixed(2);
      } else if (numAmount > 1000) {
        const majorUnits = numAmount / 100;
        // If dividing by 100 gives a value < 1000, assume it's in cents
        if (majorUnits < 1000 && majorUnits >= 1) {
          priceAmount = majorUnits.toFixed(2);
        } else {
          priceAmount = numAmount.toString();
        }
      } else {
        // Already in major units (or very small price)
        priceAmount = numAmount.toString();
      }
    }
    
    // Extract optionValues from options
    const optionValues: Record<string, string[]> = {};
    const options = Array.isArray(node.options) ? node.options : [];
    for (const opt of options) {
      if (opt?.name && Array.isArray(opt.values)) {
        const key = opt.name.toLowerCase();
        optionValues[key] = opt.values.filter((v: any) => v != null).map((v: any) => String(v));
      }
    }
    
    // Build convenience arrays for sizes/colors/materials
    const sizes: string[] = optionValues["size"] || [];
    const colors: string[] = (optionValues["color"] || []).concat(optionValues["colour"] || []);
    const materials: string[] = optionValues["material"] || [];
    
    // Improved availability heuristic
    let available = false;
    const totalInventory = node.totalInventory ?? 0;
    if (totalInventory > 0) {
      available = true;
    } else {
      // Check if first variant has inventoryPolicy = "CONTINUE"
      const firstVariant = node.variants?.edges?.[0]?.node;
      if (firstVariant?.inventoryPolicy === "CONTINUE") {
        available = true;
      } else {
        available = false;
      }
    }
    
    return {
      handle: node.handle,
      title: node.title,
      image: node.featuredImage?.url || null,
      price: priceAmount, // Keep for backwards compatibility
      priceAmount: priceAmount,
      currencyCode: currencyCode,
      url: node.onlineStoreUrl || `/products/${node.handle}`,
      tags: node.tags || [],
      available: available,
      productType: node.productType || null,
      vendor: node.vendor || null,
      description: node.description || null,
      status: node.status || null,
      // Add option intelligence
      optionValues: optionValues,
      sizes: sizes,
      colors: colors,
      materials: materials,
    } as any;
  });
  
  // Debug log for GraphQL mapping
  const withOptions = mapped.filter(p => Object.keys((p as any).optionValues || {}).length > 0).length;
  const sizeValues = mapped.reduce((sum, p) => sum + ((p as any).sizes?.length || 0), 0);
  const colorValues = mapped.reduce((sum, p) => sum + ((p as any).colors?.length || 0), 0);
  const materialValues = mapped.reduce((sum, p) => sum + ((p as any).materials?.length || 0), 0);
  const availableTrueCount = mapped.filter(p => p.available).length;
  
  console.log("[Shopify Fetch] GraphQL mapped", {
    count: mapped.length,
    withOptions,
    avgSizeValues: mapped.length > 0 ? (sizeValues / mapped.length).toFixed(1) : "0",
    avgColorValues: mapped.length > 0 ? (colorValues / mapped.length).toFixed(1) : "0",
    avgMaterialValues: mapped.length > 0 ? (materialValues / mapped.length).toFixed(1) : "0",
    availableTrueCount,
  });
  
  return mapped;
}

/**
 * Fetches products from Shopify Admin GraphQL API by specific handles
 * Used when we have saved product handles and need to fetch them directly
 */
export async function fetchShopifyProductsByHandlesGraphQL({
  shopDomain,
  accessToken,
  handles,
}: {
  shopDomain: string;
  accessToken: string;
  handles: string[];
}): Promise<
  Array<{
    handle: string;
    title: string;
    image: string | null;
    price: string | null;
    priceAmount: string | null;
    currencyCode: string | null;
    url: string;
    tags: string[];
    available: boolean;
    productType: string | null;
    vendor: string | null;
    description: string | null;
    status: string | null;
  }>
> {
  const apiVersion = "2025-01";
  const url = `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`;

  const safeHandles = (handles || []).filter(Boolean);
  if (safeHandles.length === 0) return [];

  const CHUNK_SIZE = 25;

  function chunk<T>(arr: T[], size: number) {
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }

  const query = `
    query getProductsByQuery($first: Int!, $query: String!) {
      products(first: $first, query: $query) {
        edges {
          node {
            handle
            title
            featuredImage { url }
            priceRange {
              minVariantPrice { amount currencyCode }
            }
            onlineStoreUrl
            tags
            totalInventory
            productType
            vendor
            description
            status
          }
        }
      }
    }
  `;

  const all: any[] = [];
  for (const group of chunk(safeHandles, CHUNK_SIZE)) {
    const queryString = group
      .map((h) => `handle:"${String(h).replaceAll('"', '\\"')}"`)
      .join(" OR ");

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({
        query,
        variables: { first: Math.min(group.length, 250), query: queryString },
      }),
      redirect: "manual", // Don't follow redirects automatically
    });

    // Check for redirect to password page (common with password-protected stores)
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (location && location.includes("/password")) {
        throw new Error(
          `Request redirected to password page. This usually means:\n` +
          `1. The access token is invalid or expired\n` +
          `2. The shopDomain "${shopDomain}" is incorrect\n` +
          `3. The app needs to be reinstalled. Admin API should not require storefront password.`
        );
      }
    }

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      throw new Error(
        `Shopify GraphQL API error: ${response.status} ${response.statusText}\n` +
        `URL: ${url}\n` +
        `Response: ${errorBody.substring(0, 500)}`
      );
    }

    const data = await response.json();
    if (data.errors) {
      throw new Error(`Shopify GraphQL errors: ${JSON.stringify(data.errors)}`);
    }

    const products = data.data?.products?.edges?.map((edge: any) => edge.node) || [];
    all.push(...products);
  }

  // Use the SAME mapping logic style as fetchShopifyProductsGraphQL
  return all.map((node: any) => {
    const priceData = node.priceRange?.minVariantPrice;
    const rawAmount = priceData?.amount || null;
    const currencyCode = priceData?.currencyCode || null;

    let priceAmount: string | null = null;
    if (rawAmount !== null) {
      const numAmount = parseFloat(rawAmount);
      if (numAmount > 10000) priceAmount = (numAmount / 100).toFixed(2);
      else if (numAmount > 1000) {
        const majorUnits = numAmount / 100;
        priceAmount = majorUnits < 1000 && majorUnits >= 1 ? majorUnits.toFixed(2) : numAmount.toString();
      } else {
        priceAmount = numAmount.toString();
      }
    }

    return {
      handle: node.handle,
      title: node.title,
      image: node.featuredImage?.url || null,
      price: priceAmount,
      priceAmount,
      currencyCode,
      url: node.onlineStoreUrl || `/products/${node.handle}`,
      tags: node.tags || [],
      available: (node.totalInventory ?? 0) > 0,
      productType: node.productType || null,
      vendor: node.vendor || null,
      description: node.description || null,
      status: node.status || null,
    };
  });
}

