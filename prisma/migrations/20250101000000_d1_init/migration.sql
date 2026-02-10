-- CreateTable
CREATE TABLE "User" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "googleId" TEXT NOT NULL,
    "email" TEXT,
    "picture" TEXT
);

-- CreateTable
CREATE TABLE "Device" (
    "id" TEXT NOT NULL,
    "lastSeen" DATETIME,
    "name" TEXT,
    "userId" INTEGER NOT NULL,
    "tempToken" TEXT,
    "tempTokenExpiresAt" DATETIME,
    "secretToken" TEXT,
    CONSTRAINT "Device_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TurnActivity" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER NOT NULL,
    "createdAt" DATETIME DEFAULT CURRENT_TIMESTAMP,
    "bytesSent" INTEGER NOT NULL,
    "bytesReceived" INTEGER NOT NULL,
    CONSTRAINT "TurnActivity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Release" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "version" TEXT NOT NULL,
    "rolloutPercentage" INTEGER NOT NULL DEFAULT 10,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "url" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'app',
    "hash" TEXT NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "User_googleId_key" ON "User"("googleId");

-- CreateIndex
CREATE UNIQUE INDEX "Device_id_key" ON "Device"("id");

-- CreateIndex
CREATE UNIQUE INDEX "Device_secretToken_key" ON "Device"("secretToken");

-- CreateIndex
CREATE UNIQUE INDEX "Release_version_type_key" ON "Release"("version", "type");
