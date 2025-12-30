-- CreateTable
CREATE TABLE "ConciergeSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopId" TEXT NOT NULL,
    "experienceId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "resultCount" INTEGER NOT NULL DEFAULT 8,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ConciergeSession_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ConciergeSession_experienceId_fkey" FOREIGN KEY ("experienceId") REFERENCES "Experience" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ConciergeMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "imageUrl" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ConciergeMessage_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ConciergeSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ConciergeResult" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "productIds" TEXT NOT NULL DEFAULT '[]',
    "productHandles" TEXT NOT NULL DEFAULT '[]',
    "reasoning" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ConciergeResult_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ConciergeSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ConciergeSession_shopId_idx" ON "ConciergeSession"("shopId");

-- CreateIndex
CREATE INDEX "ConciergeSession_experienceId_idx" ON "ConciergeSession"("experienceId");

-- CreateIndex
CREATE INDEX "ConciergeSession_status_idx" ON "ConciergeSession"("status");

-- CreateIndex
CREATE INDEX "ConciergeMessage_sessionId_idx" ON "ConciergeMessage"("sessionId");

-- CreateIndex
CREATE INDEX "ConciergeResult_sessionId_idx" ON "ConciergeResult"("sessionId");
