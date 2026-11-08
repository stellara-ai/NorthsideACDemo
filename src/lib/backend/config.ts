// AUTO-GENERATED per app by the backend client setup tool. Do not edit by hand —
// re-run the setup tool to refresh. The double-brace tokens are replaced with
// this app's real values at generation time.

import type { BackendConfig, TableAccess } from "./types";

const tables: Record<string, TableAccess> = {"noop": "user_private"};

const buckets: Record<string, TableAccess> = {};

export const config: BackendConfig = {
  dataBaseUrl: "https://nyc.cloud.appwrite.io/v1",
  authBaseUrl: "https://app.votel.ai/api/app-backend/Nl_kK0AjPmm-4uurnTsATA/auth",
  projectId: "6a5d8bbb0026e2dc967d",
  databaseId: "db-3355171aebf84a50a4eb61ee7aeaa22b",
  appPublicId: "Nl_kK0AjPmm-4uurnTsATA",
  tables,
  buckets,
};

/** Every server function of this app has the id `<prefix><slug>`; the backend tools print the slug. */
export const functionIdPrefix = "fn-3355171aebf84a50-";

/** Every bucket of this app has the id `<prefix><slug>`; the app passes the bucket's name and the helper maps it. */
export const bucketIdPrefix = "bkt-3355171aebf84a50-";

/**
 * The buckets (by slug) whose uploads go through the platform, which refuses a file past the user's
 * storage limit. Its own export, not a key of `config`: this file is regenerated on every setup while
 * an edited types.ts is kept, and a key its BackendConfig does not declare would fail the type-check.
 */
export const enforcedBuckets: string[] = [];

/**
 * Table name -> the names of its array columns (created with `array: true`). A value sent to one of
 * them goes to the backend as it is, a list, which is what an array column takes; every other
 * object or array value is stored as JSON text. Tables with no array column are not listed.
 */
export const arrayColumns: Record<string, readonly string[]> = {};
