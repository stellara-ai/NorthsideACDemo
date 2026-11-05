// Shared types for the app backend client helper.
//
// This file is generated into the app's workspace by the backend client setup
// tool. It has ZERO third-party dependencies and contains no vendor-specific
// identifiers — it speaks to the app's own backend through our REST + WebSocket
// endpoints. Edit with care; the setup tool may overwrite it on refresh.

/**
 * Access modes a table/bucket can be created with (server-enforced). `public_create`
 * is tables only: anyone, signed in or not, adds rows; only signed-in users read them.
 */
export type TableAccess =
  | "user_private"
  | "app_users"
  | "public_read"
  | "public_create"
  | "admin_only"
  | "company_members";

/** Per-app connection settings, written by the setup tool into config.ts. */
export interface BackendConfig {
  /** Base URL for data + realtime + storage + functions (branded when available). */
  dataBaseUrl: string;
  /** Base URL for our end-user auth endpoints. */
  authBaseUrl: string;
  /** Opaque project id (wire artifact; never shown to end users). */
  projectId: string;
  /** This app's database id. */
  databaseId: string;
  /** This app's public id (used only for reference/debugging). */
  appPublicId: string;
  /** Map of table name -> access mode. */
  tables: Record<string, TableAccess>;
  /** Map of bucket name -> access mode (company_members buckets upload through the platform). */
  buckets?: Record<string, TableAccess>;
}

/**
 * Company access levels: a member reads (and may write) its companies' records; company staff
 * also see their staff-only records; staff reach every company; an admin is staff who also
 * manages the app's members (backend.companies).
 */
export type CompanyAccessLevel = "member" | "company_staff" | "staff" | "admin";

/** A user of the app as a portal admin sees it (backend.companies). */
export interface CompanyMember {
  id: string;
  email: string | null;
  name: string | null;
  labels: string[];
  verified: boolean;
  banned: boolean;
  password_set: boolean;
  company_access_level: CompanyAccessLevel | null;
  company_ids: string[];
  /** True while the backend is still applying a change to this user's company access. */
  roles_pending: boolean;
  created_at: string | null;
  last_login_at: string | null;
}

/** A user a portal admin creates. */
export interface NewMember {
  email: string;
  /** The starting password (at least 8 characters); hand it over to the user yourself. */
  password: string;
  name?: string;
  company_access_level?: CompanyAccessLevel | null;
  company_ids?: string[];
}

/** What a portal admin may change on another user. */
export interface MemberChange {
  company_access_level?: CompanyAccessLevel | null;
  company_ids?: string[];
  name?: string;
  banned?: boolean;
}

/** One page of members. */
export interface MemberPage {
  members: CompanyMember[];
  cursor: string | null;
}

/** The answer to a change. When roles_applied is false, show the notice: our record holds the
 *  change and the backend is still applying it. */
export interface MembershipResult {
  member: CompanyMember;
  roles_applied: boolean;
  notice: string | null;
  dropped_company_ids: boolean;
}

/** The signed-in end user, as returned by auth endpoints. */
export interface AppUser {
  id: string;
  email: string | null;
  name: string | null;
  labels: string[];
  verified: boolean;
  /** Company access (server-enforced): member / company_staff / staff / admin, or null for none. */
  company_access_level?: CompanyAccessLevel | null;
  /** The companies a member or company staff belongs to (staff and admin reach every company). */
  company_ids?: string[];
}

/** Session payload returned by signup/login and cached in localStorage. */
export interface Session {
  /** Our app-scoped session JWT (30-day). */
  session: string;
  /** Session expiry, epoch seconds. */
  expires_at: number;
  /**
   * Session secret used to authenticate the realtime socket (live updates).
   * Realtime rejects the data token, so this secret is what the socket sends in
   * its authentication message. Null if the backend did not issue one.
   */
  realtime_secret: string | null;
  /** Session id echoed back on logout so the server revokes this realtime session. */
  vendor_session_id: string | null;
  /**
   * True when the session came from a preview auto-login token (dev preview only,
   * <= 10 minutes). Never set by signup/login.
   */
  preview?: boolean;
  /**
   * True when the session came from a sign-in from the platform menu (24 hours,
   * renewed on every open there). Never set by signup/login.
   */
  sso?: boolean;
  /** The platform user id a sign-in from the platform menu was made for. */
  sso_user_id?: string;
  user: AppUser;
}

/** How the sign-in from the platform menu ended (backend.auth.embedSignIn()). */
export interface EmbedSignInOutcome {
  status: "signed_in" | "not_framed" | "no_offer" | "refused" | "unavailable";
  /** The server's reason when refused, e.g. "no_app_account" or "wrong_app". */
  error?: string;
}

/** A signed identity token for the app owner's own server (backend.auth.identityToken()). */
export interface IdentityToken {
  token: string;
  /** Token expiry, epoch seconds. */
  expiresAt: number;
}

/** Short-lived data/realtime token returned by the token endpoint. */
export interface DataToken {
  token: string;
  /** Token expiry, epoch seconds. */
  expires_at: number;
}

/** Filter operators, mirroring the backend query tools. */
export type FilterOp =
  | "equals"
  | "not_equals"
  | "greater_than"
  | "greater_or_equal"
  | "less_than"
  | "less_or_equal"
  | "contains"
  | "starts_with"
  | "ends_with"
  | "search"
  | "is_null"
  | "not_null"
  | "between"
  | "in";

export interface Filter {
  column: string;
  op: FilterOp;
  value?: unknown;
}

export interface SortSpec {
  column: string;
  direction?: "asc" | "desc";
}

/** Structured options for list(). */
export interface ListOptions {
  filters?: Filter[] | Record<string, unknown>;
  sort?: SortSpec[] | string;
  limit?: number;
  cursor?: string;
}

/**
 * Argument accepted by list(): either the structured {@link ListOptions} or a
 * plain equality map like `{ done: false }` (every key becomes an `equals`
 * filter). The two are distinguished at runtime by the reserved option keys.
 */
export type ListQuery = ListOptions | Record<string, unknown>;

/** A record as returned by the data API (system fields normalized).
 *
 * Generics are constrained to ``Record<string, any>`` (NOT ``extends Row``):
 * a plain ``interface Task { id: string; ... }`` has no implicit string index
 * signature, so it can never satisfy ``extends Row`` — and app code written
 * with natural interfaces would fail to compile against this client. */
export interface Row {
  id: string;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

export interface ListResult<T extends Record<string, any> = Row> {
  rows: T[];
  total: number;
  /** Pass to the next list() call to page; null when there is no next page. */
  cursor: string | null;
}

/** One row a bulk import did not write: its index in the rows you passed, and why. */
export interface BulkImportRowError {
  index: number;
  reason: string;
}

/** Progress of a bulkCreate(), reported after each chunk the platform answered. */
export interface BulkImportProgress {
  /** Rows sent so far (of `total`). */
  sent: number;
  total: number;
  created: number;
  updated: number;
  failed: number;
}

export interface BulkImportOptions {
  /** "insert" (default) adds every row; "upsert" creates or changes the row with each row's own `id`. */
  mode?: "insert" | "upsert";
  /** Rows per request, 1 to 500 (default 500). A company table works best with 100. */
  chunkSize?: number;
  /**
   * Makes a retry safe: up to 56 letters, digits, ".", "_", ":" or "-" (e.g. crypto.randomUUID()).
   * The helper sends `<importKey>:<chunk index>`, so a chunk sent again with the same rows gets its
   * first answer back instead of being written twice. Use a new key for a new import.
   */
  importKey?: string;
  /** Called after each chunk. */
  onProgress?: (progress: BulkImportProgress) => void;
}

/** What a bulkCreate() did, summed over every chunk. `errors[].index` is the row's index in your array. */
export interface BulkImportResult {
  created: number;
  updated: number;
  failed: number;
  errors: BulkImportRowError[];
}

export type RealtimeEventType = "create" | "update" | "delete";

export interface RealtimeEvent<T extends Record<string, any> = Row> {
  type: RealtimeEventType;
  row: T;
}

/** Call to stop receiving realtime events for a subscription. */
export type Unsubscribe = () => void;

export interface UploadedFile {
  id: string;
  name: string;
  /** The file's view URL. It opens without sign-in only for a public_read bucket; read a file from any other bucket with backend.files.download(bucket, id). */
  url: string;
}

export interface FunctionResult {
  status: string;
  responseStatusCode: number;
  /** Parsed JSON body when the response was JSON, else the raw string. */
  body: unknown;
}
