-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ConciergeSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "publicToken" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "experienceId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'COLLECTING',
    "resultCount" INTEGER NOT NULL DEFAULT 8,
    "answersJson" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ConciergeSession_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ConciergeSession_experienceId_fkey" FOREIGN KEY ("experienceId") REFERENCES "Experience" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_ConciergeSession" ("createdAt", "experienceId", "id", "publicToken", "resultCount", "shopId", "status", "updatedAt") SELECT "createdAt", "experienceId", "id", "publicToken", "resultCount", "shopId", "status", "updatedAt" FROM "ConciergeSession";
DROP TABLE "ConciergeSession";
ALTER TABLE "new_ConciergeSession" RENAME TO "ConciergeSession";
CREATE UNIQUE INDEX "ConciergeSession_publicToken_key" ON "ConciergeSession"("publicToken");
CREATE INDEX "ConciergeSession_shopId_idx" ON "ConciergeSession"("shopId");
CREATE INDEX "ConciergeSession_publicToken_idx" ON "ConciergeSession"("publicToken");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
