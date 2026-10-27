import type { GcsStorageBindings, ObjectStore } from '@papercusp/artifact-registry';

export interface Env extends GcsStorageBindings {
  // Bindings
  DB: D1Database;
  COUNTERS: KVNamespace;
  ARCHIVE: ObjectStore;

  // Secrets
  CF_MASTER_TOKEN: string;
  CF_ACCOUNT_ID: string;
  JWT_SECRET: string;
  HASH_PEPPER: string;

  // Vars
  ENVIRONMENT: string;
  VANITY_HOST: string;
  PUBLISH_HOST: string;
  RATE_PER_TENANT_BURST: string;
  RATE_PER_TENANT_DAILY_FREE: string;
  RATE_PER_TENANT_DAILY_PAID: string;
  RATE_PER_IP_PUBLISH_DAILY: string;
  RATE_PER_IP_REGISTER_HOURLY: string;
  DEPLOYMENT_BYTES_CAP: string;
  DEPLOYMENT_FILES_CAP: string;
  PER_FILE_BYTES_CAP: string;
  ARCHIVE_PREFIX: string;
}

import { b64uDecode } from '@papercusp/publish-auth';

export function jwtKey(env: Env): Uint8Array {
  return b64uDecode(env.JWT_SECRET);
}

export function hashPepper(env: Env): Uint8Array {
  return b64uDecode(env.HASH_PEPPER);
}
