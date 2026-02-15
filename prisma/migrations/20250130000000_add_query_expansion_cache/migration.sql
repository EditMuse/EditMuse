-- CreateTable
CREATE TABLE "QueryExpansionCache" (
    "id" TEXT NOT NULL,
    "cacheKey" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "term" TEXT NOT NULL,
    "synonymsJson" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QueryExpansionCache_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "QueryExpansionCache_cacheKey_key" ON "QueryExpansionCache"("cacheKey");

-- CreateIndex
CREATE INDEX "QueryExpansionCache_shopId_expiresAt_idx" ON "QueryExpansionCache"("shopId", "expiresAt");

-- CreateIndex
CREATE INDEX "QueryExpansionCache_cacheKey_expiresAt_idx" ON "QueryExpansionCache"("cacheKey", "expiresAt");

-- CreateIndex
CREATE INDEX "QueryExpansionCache_expiresAt_idx" ON "QueryExpansionCache"("expiresAt");

-- AddForeignKey
ALTER TABLE "QueryExpansionCache" ADD CONSTRAINT "QueryExpansionCache_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

