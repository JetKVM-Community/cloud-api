import type { PrismaClient } from "@prisma/client/edge";

export type Env = {
  // Cloudflare Bindings
  R2_BUCKET: R2Bucket;
  DB: D1Database;
  DEVICE_SIGNALING: DurableObjectNamespace;

  // OIDC provider (e.g. Cloudflare One / Access)
  OIDC_ISSUER: string;       // e.g. https://<team>.cloudflareaccess.com
  OIDC_CLIENT_ID: string;
  OIDC_CLIENT_SECRET: string;

  // Environment variables
  API_HOSTNAME: string;
  APP_HOSTNAME: string;
  COOKIE_SECRET: string;
  CLOUDFLARE_TURN_ID: string;
  CLOUDFLARE_TURN_TOKEN: string;
  R2_CDN_URL: string;
  CORS_ORIGINS: string;
  ALLOWED_IDENTITIES?: string;
  REAL_IP_HEADER?: string;
  ICE_SERVERS?: string;
};

export type SessionData = {
  id_token?: string;
  csrf?: string;
  code_verifier?: string;
  deviceId?: string;
  returnTo?: string;
  [key: string]: string | undefined;
};

export type AppType = {
  Bindings: Env;
  Variables: {
    session: SessionData;
    prisma: PrismaClient;
  };
};
