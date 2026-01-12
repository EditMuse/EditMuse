-- AlterTable
ALTER TABLE "Shop" ADD COLUMN "trialEndsAt" DATETIME;
ALTER TABLE "Shop" ADD COLUMN "trialStartedAt" DATETIME;

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopId" TEXT NOT NULL,
    "planTier" TEXT NOT NULL DEFAULT 'TRIAL',
    "shopifySubscriptionId" TEXT,
    "shopifyChargeId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "currentPeriodStart" DATETIME,
    "currentPeriodEnd" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Subscription_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "UsageEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "metadata" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UsageEvent_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_shopId_key" ON "Subscription"("shopId");

-- CreateIndex
CREATE INDEX "UsageEvent_shopId_createdAt_idx" ON "UsageEvent"("shopId", "createdAt");

-- CreateIndex
CREATE INDEX "UsageEvent_shopId_eventType_createdAt_idx" ON "UsageEvent"("shopId", "eventType", "createdAt");
