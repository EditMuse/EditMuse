/**
 * Temporary test route to query usage records
 * Access via: 
 *   /app/test-usage-record (queries currentAppInstallation)
 *   /app/test-usage-record?subscriptionId=gid://shopify/AppSubscription/... (query specific subscription)
 */

import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "~/shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  
  const url = new URL(request.url);
  const subscriptionId = url.searchParams.get("subscriptionId");
  
  // Query 1: Query via currentAppInstallation (no ID needed)
  const query1 = `
    query GetUsageRecords {
      currentAppInstallation {
        activeSubscriptions {
          id
          name
          status
          lineItems {
            id
            plan {
              pricingDetails {
                __typename
                ... on AppUsagePricing {
                  cappedAmount {
                    amount
                    currencyCode
                  }
                  balanceUsed {
                    amount
                    currencyCode
                  }
                }
              }
            }
            usageRecords(first: 50) {
              edges {
                node {
                  id
                  createdAt
                  description
                  price {
                    amount
                    currencyCode
                  }
                }
              }
            }
          }
        }
      }
    }
  `;
  
  // Query 2: Query specific subscription by ID
  const query2 = `
    query GetUsageRecordsForSubscription($subscriptionId: ID!) {
      node(id: $subscriptionId) {
        ... on AppSubscription {
          id
          name
          status
          lineItems {
            id
            plan {
              pricingDetails {
                __typename
                ... on AppUsagePricing {
                  cappedAmount {
                    amount
                    currencyCode
                  }
                  balanceUsed {
                    amount
                    currencyCode
                  }
                }
              }
            }
            usageRecords(first: 50) {
              edges {
                node {
                  id
                  createdAt
                  description
                  price {
                    amount
                    currencyCode
                  }
                }
              }
            }
          }
        }
      }
    }
  `;
  
  try {
    const response = subscriptionId
      ? await admin.graphql(query2, { variables: { subscriptionId } })
      : await admin.graphql(query1);
    
    const data = await response.json();
    
    return Response.json(data, {
      headers: {
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
};

