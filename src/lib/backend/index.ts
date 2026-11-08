// Public entry point for the app backend client helper.
//
// Usage:
//   import { backend } from "./lib/backend";
//   await backend.auth.login(email, password);
//   const { rows } = await backend.from("tasks").list({ done: false });
//   const stop = backend.from("tasks").subscribe((e) => console.log(e.type, e.row));

import { auth } from "./auth";
import { companies } from "./companies";
import { from } from "./data";
import { files } from "./files";
import { functions } from "./functions";

export const backend = {
  auth,
  companies,
  from,
  files,
  functions,
};

export type {
  AppUser,
  BackendConfig,
  BulkImportOptions,
  BulkImportProgress,
  BulkImportResult,
  BulkImportRowError,
  CompanyAccessLevel,
  CompanyMember,
  DataToken,
  EmbedSignInOutcome,
  Filter,
  FilterOp,
  ListOptions,
  ListQuery,
  ListResult,
  MemberChange,
  MemberPage,
  MembershipResult,
  NewMember,
  RealtimeEvent,
  RealtimeEventType,
  Row,
  Session,
  SortSpec,
  StorageUsage,
  TableAccess,
  Unsubscribe,
  UploadedFile,
  FunctionResult,
  IdentityToken,
} from "./types";

export { AuthError } from "./auth";
export { BackendError, CounterLimitError } from "./data";
export { readStorageLimitError } from "./storageLimit";
export type { StorageLimitExceeded } from "./storageLimit";

export default backend;
