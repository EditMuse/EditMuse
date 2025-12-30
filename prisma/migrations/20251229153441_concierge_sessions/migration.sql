/*
  Warnings:

  - You are about to alter the column `productHandles` on the `ConciergeResult` table. The data in that column could be lost. The data in that column will be cast from `String` to `Json`.
  - You are about to alter the column `productIds` on the `ConciergeResult` table. The data in that column could be lost. The data in that column will be cast from `String` to `Json`.
  - Added the required column `publicToken` to the `ConciergeSession` table without a default value. This is not possible if the table is not empty.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ConciergeMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'USER',
    "text" TEXT,
    "imageUrl" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ConciergeMessage_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ConciergeSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_ConciergeMessage" ("createdAt", "id", "imageUrl", "role", "sessionId", "text") SELECT "createdAt", "id", "imageUrl", "role", "sessionId", "text" FROM "ConciergeMessage";
DROP TABLE "ConciergeMessage";
ALTER TABLE "new_ConciergeMessage" RENAME TO "ConciergeMessage";
CREATE INDEX "ConciergeMessage_sessionId_idx" ON "ConciergeMessage"("sessionId");
CREATE TABLE "new_ConciergeResult" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "productHandles" JSONB NOT NULL,
    "productIds" JSONB,
    "reasoning" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ConciergeResult_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ConciergeSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_ConciergeResult" ("createdAt", "id", "productHandles", "productIds", "reasoning", "sessionId") SELECT "createdAt", "id", "productHandles", "productIds", "reasoning", "sessionId" FROM "ConciergeResult";
DROP TABLE "ConciergeResult";
ALTER TABLE "new_ConciergeResult" RENAME TO "ConciergeResult";
CREATE UNIQUE INDEX "ConciergeResult_sessionId_key" ON "ConciergeResult"("sessionId");
CREATE TABLE "new_ConciergeSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "publicToken" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "experienceId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'COLLECTING',
    "resultCount" INTEGER NOT NULL DEFAULT 8,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ConciergeSession_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ConciergeSession_experienceId_fkey" FOREIGN KEY ("experienceId") REFERENCES "Experience" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_ConciergeSession" ("createdAt", "experienceId", "id", "resultCount", "shopId", "status", "updatedAt") SELECT "createdAt", "experienceId", "id", "resultCount", "shopId", "status", "updatedAt" FROM "ConciergeSession";
DROP TABLE "ConciergeSession";
ALTER TABLE "new_ConciergeSession" RENAME TO "ConciergeSession";
CREATE UNIQUE INDEX "ConciergeSession_publicToken_key" ON "ConciergeSession"("publicToken");
CREATE INDEX "ConciergeSession_shopId_idx" ON "ConciergeSession"("shopId");
CREATE INDEX "ConciergeSession_publicToken_idx" ON "ConciergeSession"("publicToken");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
