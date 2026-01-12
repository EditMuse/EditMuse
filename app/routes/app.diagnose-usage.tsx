/**
 * Diagnostic route to compare usage record subscription with active subscription
 * Access via: /app/diagnose-usage?usageRecordId=gid://shopify/AppUsageRecord/508353380425
 */

import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "~/shopify.server";
import { getActiveCharge } from "~/models/shopify-billing.server";
import prisma from "~/db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  
  const url = new URL(request.url);
  const usageRecordId = url.searchParams.get("usageRecordId") || "gid://shopify/AppUsageRecord/508353380425";
  
  // Query 1: Get the usage record and see which subscriptionLineItem it belongs to
  const query1 = `
    query GetUsageRecord($id: ID!) {
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
                }
              }
            }
          }
        }
      }
    }
  `;
  
  // Query 2: Get all active subscriptions with their line items
  const query2 = `
    query GetActiveSubscriptions {
      currentAppInstallation {
        activeSubscriptions {
          id
          name
          status
          createdAt
          currentPeriodEnd
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
                  description
                  price {
                    amount
                    currencyCode
                  }
                  createdAt
                }
              }
            }
          }
        }
      }
    }
  `;
  
  try {
    // Get the usage record
    const response1 = await admin.graphql(query1, { variables: { id: usageRecordId } });
    const usageRecordData = await response1.json();
    
    // Get active subscriptions
    const response2 = await admin.graphql(query2);
    const subscriptionsData = await response2.json();
    
    // Get shop and subscription from DB
    const shop = await prisma.shop.findUnique({
      where: { domain: session.shop },
      include: { subscription: true },
    });
    
    // Get active charge using our helper
    const activeCharge = await getActiveCharge(session.shop, { admin });
    
    // Build diagnostic result
    const diagnostic = {
      usageRecord: usageRecordData.data?.node,
      usageRecordSubscriptionLineItemId: usageRecordData.data?.node?.subscriptionLineItem?.id,
      activeSubscriptions: subscriptionsData.data?.currentAppInstallation?.activeSubscriptions || [],
      dbSubscription: shop?.subscription ? {
        id: shop.subscription.id,
        shopifySubscriptionGid: shop.subscription.shopifySubscriptionGid,
        shopifyUsageLineItemGid: shop.subscription.shopifyUsageLineItemGid,
        shopifyRecurringLineItemGid: shop.subscription.shopifyRecurringLineItemGid,
        planTier: shop.subscription.planTier,
        status: shop.subscription.status,
      } : null,
      activeChargeFromHelper: activeCharge ? {
        id: activeCharge.id,
        name: activeCharge.name,
        usageLineItemGid: activeCharge.usageLineItemGid,
        recurringLineItemGid: activeCharge.recurringLineItemGid,
      } : null,
      analysis: {
        usageRecordLineItemId: usageRecordData.data?.node?.subscriptionLineItem?.id,
        dbUsageLineItemGid: shop?.subscription?.shopifyUsageLineItemGid,
        activeChargeUsageLineItemGid: activeCharge?.usageLineItemGid,
        matches: {
          usageRecordVsDb: usageRecordData.data?.node?.subscriptionLineItem?.id === shop?.subscription?.shopifyUsageLineItemGid,
          usageRecordVsActiveCharge: usageRecordData.data?.node?.subscriptionLineItem?.id === activeCharge?.usageLineItemGid,
          dbVsActiveCharge: shop?.subscription?.shopifyUsageLineItemGid === activeCharge?.usageLineItemGid,
        },
      },
    };
    
    return Response.json(diagnostic, {
      headers: {
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    return Response.json(
      { 
        error: error instanceof Error ? error.message : "Unknown error",
        stack: error instanceof Error ? error.stack : undefined,
      },
      { status: 500 }
    );
  }
};

