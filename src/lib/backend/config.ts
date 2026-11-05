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
