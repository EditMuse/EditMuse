/**
 * Query a usage record by ID using the app's authentication
 * Usage: node scripts/query-usage-record.mjs <shop-domain> <usage-record-id>
 * 
 * Example:
 * node scripts/query-usage-record.mjs editmuse.myshopify.com gid://shopify/AppUsageRecord/508353380425
 */

import { PrismaClient } from "@prisma/client";
import shopify from "../app/shopify.server.js";

const prisma = new PrismaClient();

const shopDomain = process.argv[2];
const usageRecordId = process.argv[3];

if (!shopDomain || !usageRecordId) {
  console.error("Usage: node scripts/query-usage-record.mjs <shop-domain> <usage-record-id>");
  console.error("Example: node scripts/query-usage-record.mjs editmuse.myshopify.com gid://shopify/AppUsageRecord/508353380425");
  process.exit(1);
}

const query = `
  query getAppUsageRecord($id: ID!) {
    node(id: $id) {
      ... on AppUsageRecord {
        id
        description
        price {
          amount
          currencyCode
        }
        createdAt
        subscriptionLineItem {
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
                terms
              }
            }
          }
        }
      }
    }
  }
`;

try {
  // Load session to get access token
  const session = await shopify.sessionStorage.loadSession(shopDomain);
  
  if (!session || !session.accessToken) {
    console.error(`No session found for shop: ${shopDomain}`);
    console.error("Please make sure the app is installed and authenticated.");
    process.exit(1);
  }

  // Run the query using the access token
  const apiVersion = "2026-01";
  const url = `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`;

  console.log(`Querying usage record: ${usageRecordId}`);
  console.log(`For shop: ${shopDomain}\n`);
  
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": session.accessToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query,
      variables: {
        id: usageRecordId,
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`GraphQL API error: ${response.status}`);
    console.error(errorText);
    process.exit(1);
  }

  const data = await response.json();

  if (data.errors) {
    console.error("GraphQL errors:");
    console.error(JSON.stringify(data.errors, null, 2));
    process.exit(1);
  }

  console.log("Result:");
  console.log(JSON.stringify(data.data, null, 2));
} catch (error) {
  console.error("Error:", error.message);
  if (error.stack) {
    console.error(error.stack);
  }
  process.exit(1);
} finally {
  await prisma.$disconnect();
}

