-- Rename googleId to oidcId for generic OIDC provider support
ALTER TABLE "User" RENAME COLUMN "googleId" TO "oidcId";

-- Recreate the unique index with the new column name
DROP INDEX IF EXISTS "User_googleId_key";
CREATE UNIQUE INDEX "User_oidcId_key" ON "User"("oidcId");
