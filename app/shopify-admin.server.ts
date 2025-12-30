/**
 * Helper functions for making Shopify Admin API calls using shop access tokens
 */

/**
 * Fetches products from Shopify Admin API using shop access token
 */
export async function fetchShopifyProducts({
  shopDomain,
  accessToken,
  limit = 50,
}: {
  shopDomain: string;
  accessToken: string;
  limit?: number;
}): Promise<Array<{
  handle: string;
  title: string;
  image: string | null;
  price: string | null;
}>> {
  const apiVersion = "2025-01";
  const url = `https://${shopDomain}/admin/api/${apiVersion}/products.json?limit=${limit}&fields=id,title,handle,images,variants`;

  const response = await fetch(url, {
    headers: {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Shopify API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  const products = data.products || [];

  return products.map((product: any) => ({
    handle: product.handle,
    title: product.title,
    image: product.images?.[0]?.src || null,
    price: product.variants?.[0]?.price || null,
  }));
}

