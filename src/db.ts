import { PrismaD1 } from "@prisma/adapter-d1";
import { PrismaClient } from './generated/prisma/';

/**
 * Creates a PrismaClient connected to Cloudflare D1.
 *
 * D1 is Cloudflare's serverless SQL database built on SQLite.
 * A new PrismaClient is created per request using the D1 binding.
 */
export function createPrisma(db: D1Database): PrismaClient {
  const adapter = new PrismaD1(db);
  return new PrismaClient({ adapter });
}

