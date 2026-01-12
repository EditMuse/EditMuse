-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Experience" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "resultCount" INTEGER NOT NULL DEFAULT 8,
    "tone" TEXT,
    "includedCollections" TEXT NOT NULL DEFAULT '[]',
    "excludedTags" TEXT NOT NULL DEFAULT '[]',
    "inStockOnly" BOOLEAN NOT NULL DEFAULT false,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "questionsJson" TEXT NOT NULL DEFAULT '[]',
    "brandStyle" TEXT NOT NULL DEFAULT 'pop',
    "modalStyle" TEXT NOT NULL DEFAULT 'centered',
    "showProgressBar" BOOLEAN NOT NULL DEFAULT true,
    "showCloseButton" BOOLEAN NOT NULL DEFAULT true,
    "optionStyle" TEXT NOT NULL DEFAULT 'pills',
    "stickyNavigation" BOOLEAN NOT NULL DEFAULT true,
    "accent" TEXT,
    "accent2" TEXT,
    "surface" TEXT,
    "textColor" TEXT,
    "radius" INTEGER NOT NULL DEFAULT 18,
    "overlayOpacity" INTEGER NOT NULL DEFAULT 40,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Experience_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Experience" ("createdAt", "excludedTags", "id", "inStockOnly", "includedCollections", "isDefault", "mode", "name", "questionsJson", "resultCount", "shopId", "tone", "updatedAt") SELECT "createdAt", "excludedTags", "id", "inStockOnly", "includedCollections", "isDefault", "mode", "name", "questionsJson", "resultCount", "shopId", "tone", "updatedAt" FROM "Experience";
DROP TABLE "Experience";
ALTER TABLE "new_Experience" RENAME TO "Experience";
CREATE INDEX "Experience_shopId_idx" ON "Experience"("shopId");
CREATE INDEX "Experience_shopId_isDefault_idx" ON "Experience"("shopId", "isDefault");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
