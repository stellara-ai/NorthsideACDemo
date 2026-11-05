// Data access for the app backend: backend.from(table).list/get/create/update/upsert/
// increment/decrement/remove/bulkCreate.
//
// Speaks the backend's raw REST wire directly. The only place (besides realtime.ts)
// where wire header names live is WIRE_HEADERS below — they are transport artifacts,
// never surfaced to app code or end users.

import { auth, AuthError } from "./auth";
import { config } from "./config";
import { subscribeToRow, subscribeToTable } from "./realtime";
import type {
  BulkImportOptions,
  BulkImportResult,
  Filter,
  FilterOp,
  ListOptions,
  ListQuery,
  ListResult,
  RealtimeEvent,
  Row,
  SortSpec,
  Unsubscribe,
} from "./types";

/** Wire header names (transport only; not part of the public API). */
export const WIRE_HEADERS = { project: "X-Appwrite-Project", jwt: "X-Appwrite-JWT" } as const;

/** Thrown on a non-OK data response; `status` carries the HTTP status. */
export class BackendError extends Error {
  readonly status: number;
  constructor(status: number, message?: string) {
    super(message && message.length > 0 ? message : `backend_error_${status}`);
    this.status = status;
    this.name = "BackendError";
  }
}

/**
 * Thrown by increment()/decrement() when the change would take the column past its
 * `max` (or below its `min`). Nothing was changed. `status` is 409 and
 * readBackendError(err) reads `{ error: "counter_limit" }`.
 */
export class CounterLimitError extends BackendError {
  constructor(detail: string) {
    super(409, JSON.stringify({ error: "counter_limit", detail }));
    this.name = "CounterLimitError";
  }
}

/** Trimmed base URL for all data/storage/function calls. */
export function apiBase(): string {
  return config.dataBaseUrl.replace(/\/+$/, "");
}

/** Auth headers (project + short-lived data token) for a data request. */
export async function authHeaders(): Promise<Record<string, string>> {
  const jwt = await auth.getDataToken();
  return { [WIRE_HEADERS.project]: config.projectId, [WIRE_HEADERS.jwt]: jwt };
}

/**
 * Headers for a request a visitor who is NOT signed in may make too: reading a
 * public_read table, or calling a function deployed with access "public". With
 * someone signed in they are the auth headers. With nobody signed in, or when the
 * token exchange just refused the stored sign-in with 401 (getDataToken then cleared
 * it), only the project goes and the backend's access rules decide. Any other
 * failure is thrown: a 403 (banned account) so the app can say so, a 503 so it can
 * offer a retry without signing anyone out.
 */
export async function visitorHeaders(): Promise<Record<string, string>> {
  if (auth.isAuthenticated()) {
    try {
      return await authHeaders();
    } catch (err) {
      if (!(err instanceof AuthError) || err.status !== 401) throw err;
    }
  }
  return { [WIRE_HEADERS.project]: config.projectId };
}

const OP_METHOD: Record<FilterOp, string> = {
  equals: "equal",
  not_equals: "notEqual",
  greater_than: "greaterThan",
  greater_or_equal: "greaterThanEqual",
  less_than: "lessThan",
  less_or_equal: "lessThanEqual",
  contains: "contains",
  starts_with: "startsWith",
  ends_with: "endsWith",
  search: "search",
  is_null: "isNull",
  not_null: "isNotNull",
  between: "between",
  in: "equal",
};

const OPTION_KEYS = ["filters", "sort", "limit", "cursor"];
const DEFAULT_LIMIT = 25;

interface WireQuery {
  method: string;
  attribute?: string;
  values?: unknown[];
}

// hydrateRow exposes the system columns under friendly names (created_at /
// updated_at / id); queries must map those SAME names back to the wire names,
// or filtering/sorting by them fails with "Attribute not found in schema".
const WIRE_COLUMN_MAP: Record<string, string> = {
  id: "$id",
  created_at: "$createdAt",
  updated_at: "$updatedAt",
};

function wireColumn(column: string): string {
  return WIRE_COLUMN_MAP[column] ?? column;
}

function buildFilterQuery(filter: Filter): string {
  const method = OP_METHOD[filter.op];
  const q: WireQuery = { method, attribute: wireColumn(filter.column) };
  if (filter.op === "is_null" || filter.op === "not_null") {
    // no values for null checks
  } else if (filter.op === "between") {
    const v = Array.isArray(filter.value) ? filter.value : [];
    q.values = [v[0], v[1]];
  } else if (filter.op === "in") {
    q.values = Array.isArray(filter.value) ? filter.value : [filter.value];
  } else {
    q.values = [filter.value];
  }
  return JSON.stringify(q);
}

function buildSortQuery(sort: SortSpec): string {
  const method = sort.direction === "desc" ? "orderDesc" : "orderAsc";
  return JSON.stringify({ method, attribute: wireColumn(sort.column) });
}

function normalizeFilters(input: ListOptions["filters"]): Filter[] {
  if (!input) return [];
  if (Array.isArray(input)) return input;
  return Object.keys(input).map((column) => ({
    column,
    op: "equals" as FilterOp,
    value: (input as Record<string, unknown>)[column],
  }));
}

function normalizeSort(input: ListOptions["sort"]): SortSpec[] {
  if (!input) return [];
  if (typeof input === "string") {
    const desc = input.startsWith("-");
    return [{ column: desc ? input.slice(1) : input, direction: desc ? "desc" : "asc" }];
  }
  return input;
}

interface NormalizedQuery {
  filters: Filter[];
  sort: SortSpec[];
  limit: number;
  cursor?: string;
}

function normalizeQuery(query: ListQuery): NormalizedQuery {
  const keys = Object.keys(query);
  const isStructured = keys.some((k) => OPTION_KEYS.includes(k));
  if (!isStructured) {
    // Plain equality map, e.g. list({ done: false }).
    const filters = keys.map((column) => ({
      column,
      op: "equals" as FilterOp,
      value: (query as Record<string, unknown>)[column],
    }));
    return { filters, sort: [], limit: DEFAULT_LIMIT };
  }
  const opts = query as ListOptions;
  return {
    filters: normalizeFilters(opts.filters),
    sort: normalizeSort(opts.sort),
    limit: typeof opts.limit === "number" ? opts.limit : DEFAULT_LIMIT,
    cursor: opts.cursor,
  };
}

/** Attempt to parse a JSON-column string value back into an object/array. */
function maybeParseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const s = value.trim();
  if (s.length < 2) return value;
  const first = s[0];
  const last = s[s.length - 1];
  if ((first === "{" && last === "}") || (first === "[" && last === "]")) {
    try {
      return JSON.parse(s);
    } catch {
      return value;
    }
  }
  return value;
}

/** Normalize a raw wire row into a friendly Row (id + parsed columns). */
export function hydrateRow(raw: Record<string, unknown>): Row {
  const row: Row = { id: String(raw["$id"] ?? "") };
  if (typeof raw["$createdAt"] === "string") row.created_at = raw["$createdAt"];
  if (typeof raw["$updatedAt"] === "string") row.updated_at = raw["$updatedAt"];
  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith("$")) continue;
    row[key] = maybeParseJson(value);
  }
  return row;
}

/** Stringify object/array values so JSON columns round-trip through text storage. */
function serialize(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    out[key] = value !== null && typeof value === "object" ? JSON.stringify(value) : value;
  }
  return out;
}

/**
 * Add one row for a visitor who is NOT signed in. Only a `public_create` table takes
 * it, and only through the platform, which checks the columns and limits how often
 * one visitor can submit; the new row is the only thing that comes back.
 */
async function submitSignedOut(
  table: string,
  data: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  // authBaseUrl is ".../api/app-backend/<app>/auth"; the submission route is its sibling.
  const appBase = config.authBaseUrl.replace(/\/+$/, "").replace(/\/auth$/, "");
  const res = await fetch(`${appBase}/tables/${encodeURIComponent(table)}/rows`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: serialize(data) }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new BackendError(res.status, text);
  }
  return (await res.json()) as Record<string, unknown>;
}

/** The platform's per-app base: ".../api/app-backend/<app>" (the auth URL's parent). */
export function platformBase(): string {
  return config.authBaseUrl.replace(/\/+$/, "").replace(/\/auth$/, "");
}

/** What a refused write said: `{ error, detail }` from a BackendError's body, when it carries one. */
export function readBackendError(err: unknown): { status: number; error: string; detail?: string } | null {
  if (!(err instanceof BackendError)) return null;
  try {
    const body = JSON.parse(err.message) as { error?: unknown; detail?: unknown };
    return {
      status: err.status,
      error: typeof body.error === "string" ? body.error : `error_${err.status}`,
      detail: typeof body.detail === "string" ? body.detail : undefined,
    };
  } catch {
    return { status: err.status, error: `error_${err.status}` };
  }
}

/**
 * A create or change on a company table (company_members). The backend grants nobody
 * a write there: the platform checks the caller's company access and the record's
 * references, then writes it with the company's grants.
 */
async function companyWrite(
  method: "POST" | "PATCH",
  path: string,
  data: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const session = auth.currentSession();
  if (!session || session.expires_at * 1000 <= Date.now()) throw new AuthError(401);
  const res = await fetch(`${platformBase()}/company${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.session}` },
    body: JSON.stringify({ data: serialize(data) }),
  });
  if (res.status === 401) {
    await auth.logout();
    throw new AuthError(401);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new BackendError(res.status, text);
  }
  return (await res.json()) as Record<string, unknown>;
}

async function dataFetch(
  path: string,
  init: RequestInit = {},
  signedOutAllowed = false,
): Promise<Record<string, unknown> | null> {
  const headers: Record<string, string> = {
    ...(await (signedOutAllowed ? visitorHeaders() : authHeaders())),
  };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (init.headers) Object.assign(headers, init.headers as Record<string, string>);
  const res = await fetch(`${apiBase()}${path}`, { ...init, headers });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new BackendError(res.status, text);
  }
  if (res.status === 204) return null;
  return (await res.json()) as Record<string, unknown>;
}

/** The backend's error types for a counter change that would pass its bound. */
const COUNTER_LIMIT_TYPES = ["column_limit_exceeded", "attribute_limit_exceeded"];

function isCounterLimit(err: unknown): boolean {
  if (!(err instanceof BackendError) || err.status !== 400) return false;
  try {
    const body = JSON.parse(err.message) as { type?: unknown };
    return typeof body.type === "string" && COUNTER_LIMIT_TYPES.includes(body.type);
  } catch {
    return false;
  }
}

/** The backend's error types for a counter on a row it does not have (it names the column even then). */
const COUNTER_ROW_NOT_FOUND_TYPES = ["column_not_found", "row_not_found", "document_not_found"];

function backendErrorType(err: unknown, status: number): string | null {
  if (!(err instanceof BackendError) || err.status !== status) return null;
  try {
    const body = JSON.parse(err.message) as { type?: unknown };
    return typeof body.type === "string" ? body.type : null;
  } catch {
    return null;
  }
}

/** A refusal made here, before any request: the same `{ error, detail }` body the platform sends. */
function refusal(status: number, error: string, detail: string): BackendError {
  return new BackendError(status, JSON.stringify({ error, detail }));
}

/**
 * Add `by` to (increment) or take it from (decrement) one number column of one row, in
 * ONE atomic step at the backend: two users pressing at once both count, and a change
 * whose result would pass `bound` changes nothing and throws CounterLimitError.
 */
async function changeCounter(
  rowPath: string,
  column: string,
  direction: "increment" | "decrement",
  by: number,
  bound: number | undefined,
): Promise<Record<string, unknown>> {
  if (typeof by !== "number" || !Number.isFinite(by) || by <= 0) {
    throw refusal(400, "invalid_request", "by must be a number greater than 0");
  }
  const body: Record<string, unknown> = { value: by };
  if (bound !== undefined) body[direction === "increment" ? "max" : "min"] = bound;
  try {
    const raw = await dataFetch(`${rowPath}/${encodeURIComponent(column)}/${direction}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    return raw ?? {};
  } catch (err) {
    if (isCounterLimit(err)) {
      throw new CounterLimitError(
        direction === "increment" ? `${column} would go above ${bound}` : `${column} would go below ${bound}`,
      );
    }
    // The backend answers a missing row and a missing column with the same 404.
    const notFoundType = backendErrorType(err, 404);
    if (notFoundType !== null && COUNTER_ROW_NOT_FOUND_TYPES.includes(notFoundType)) {
      const rowId = decodeURIComponent(rowPath.slice(rowPath.lastIndexOf("/") + 1));
      throw refusal(404, "row_not_found", `no row "${rowId}" in this table, or the table has no column "${column}"`);
    }
    // A fractional amount or bound on a whole-number column fails at the backend with a
    // bare 500 (a decimal column takes it); say what the call can change instead.
    const fractional = !Number.isInteger(by) || (bound !== undefined && !Number.isInteger(bound));
    if (fractional && err instanceof BackendError && err.status === 500) {
      throw refusal(
        400,
        "invalid_request",
        bound === undefined
          ? `the backend refused a fractional amount: when ${column} holds whole numbers, by must be a whole number`
          : `the backend refused a fractional amount: when ${column} holds whole numbers, by and ${direction === "increment" ? "max" : "min"} must be whole numbers`,
      );
    }
    throw err;
  }
}

/** Rows per bulk import request: the platform takes at most 500. */
const BULK_IMPORT_MAX_CHUNK = 500;
/** Times one chunk is sent again after a 429 or an import still in progress. */
const BULK_IMPORT_MAX_RETRIES = 6;
const BULK_IMPORT_DEFAULT_RETRY_SECONDS = 5;
const BULK_IMPORT_MAX_RETRY_SECONDS = 60;
/** The import key the caller passes; the helper appends `:<chunk index>` (the platform takes 64). */
const BULK_IMPORT_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,55}$/;

interface BulkImportChunkAnswer {
  created: number;
  updated: number;
  failed: number;
  errors: { index: number; reason: string }[];
}

function retryAfterSeconds(res: Response): number {
  const seconds = Number(res.headers.get("Retry-After"));
  if (!Number.isFinite(seconds) || seconds <= 0) return BULK_IMPORT_DEFAULT_RETRY_SECONDS;
  return Math.min(seconds, BULK_IMPORT_MAX_RETRY_SECONDS);
}

function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

/**
 * One bulk import request (at most 500 rows) through the platform, as the signed-in user.
 * A 429, or the same import key still running, is waited out (Retry-After) and sent again.
 */
async function importChunk(
  table: string,
  rows: Record<string, unknown>[],
  mode: "insert" | "upsert",
  importKey?: string,
): Promise<BulkImportChunkAnswer> {
  const body: Record<string, unknown> = { rows, mode };
  if (importKey) body.import_key = importKey;
  for (let attempt = 0; ; attempt++) {
    const session = auth.currentSession();
    if (!session || session.expires_at * 1000 <= Date.now()) throw new AuthError(401);
    const res = await fetch(`${platformBase()}/tables/${encodeURIComponent(table)}/rows/bulk`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.session}` },
      body: JSON.stringify(body),
    });
    if (res.status === 401) {
      await auth.logout();
      throw new AuthError(401);
    }
    if (res.ok) return (await res.json()) as BulkImportChunkAnswer;
    const text = await res.text().catch(() => "");
    const waitable = res.status === 429 || (res.status === 409 && text.includes("import_in_progress"));
    if (!waitable || attempt >= BULK_IMPORT_MAX_RETRIES) throw new BackendError(res.status, text);
    await sleep(retryAfterSeconds(res));
  }
}

/** A typed handle to one table. */
export interface TableClient<T extends Record<string, any> = Row> {
  list(query?: ListQuery): Promise<ListResult<T>>;
  get(id: string): Promise<T | null>;
  create(data: Record<string, unknown>): Promise<T>;
  update(id: string, data: Record<string, unknown>): Promise<T>;
  /**
   * Create the row with this id, or change it when it exists (only the columns sent
   * change; every required column must be sent). A new row gets the same owner as
   * create() gives it. Signed-in users only; not on a company table.
   */
  upsert(id: string, data: Record<string, unknown>): Promise<T>;
  /** Atomically add `by` (default 1) to a number column; throws CounterLimitError past `max`. */
  increment(id: string, column: string, by?: number, options?: { max?: number }): Promise<T>;
  /** Atomically take `by` (default 1) from a number column; throws CounterLimitError below `min`. */
  decrement(id: string, column: string, by?: number, options?: { min?: number }): Promise<T>;
  remove(id: string): Promise<void>;
  /**
   * Import many rows at once from an admin screen (a CSV, a paste): never a loop of create().
   * Needs the table's bulk_import_roles and a signed-in user carrying one of those labels; anyone
   * else gets BackendError 403 (readBackendError(err)?.error === "bulk_import_not_allowed").
   * Rows go in chunks of up to 500, one after the other; a row the backend refuses is listed in
   * `errors` with its index while the others are written. A chunk the platform could not finish
   * (503) throws and may be partly written: pass `importKey` and upsert with your own ids to retry
   * it safely. A company table needs company_id in each row (and works best with chunkSize 100).
   */
  bulkCreate(rows: Record<string, unknown>[], options?: BulkImportOptions): Promise<BulkImportResult>;
  subscribe(callback: (event: RealtimeEvent<T>) => void): Unsubscribe;
  subscribeRow(id: string, callback: (event: RealtimeEvent<T>) => void): Unsubscribe;
}

/** Open a handle to a table by name. */
export function from<T extends Record<string, any> = Row>(table: string): TableClient<T> {
  const rowsPath = `/tablesdb/${config.databaseId}/tables/${encodeURIComponent(table)}/rows`;
  // Anyone may read a public_read table, so its reads also work with nobody signed in.
  const readableSignedOut = config.tables[table] === "public_read";
  // A company table is written through the platform, which checks the company.
  const companyScoped = config.tables[table] === "company_members";
  const companyRows = `/tables/${encodeURIComponent(table)}/rows`;

  return {
    async list(query: ListQuery = {}): Promise<ListResult<T>> {
      const { filters, sort, limit, cursor } = normalizeQuery(query);
      const queries: string[] = [];
      for (const filter of filters) queries.push(buildFilterQuery(filter));
      for (const spec of sort) queries.push(buildSortQuery(spec));
      queries.push(JSON.stringify({ method: "limit", values: [limit] }));
      if (cursor) queries.push(JSON.stringify({ method: "cursorAfter", values: [cursor] }));
      const qs = queries.map((q, i) => `queries[${i}]=${encodeURIComponent(q)}`).join("&");
      const raw = await dataFetch(`${rowsPath}${qs ? `?${qs}` : ""}`, {}, readableSignedOut);
      const rawRows = Array.isArray(raw?.rows) ? (raw?.rows as Record<string, unknown>[]) : [];
      const rows = rawRows.map((r) => hydrateRow(r) as unknown as T);
      const total = typeof raw?.total === "number" ? raw.total : rows.length;
      const nextCursor = rows.length >= limit && rows.length > 0 ? rows[rows.length - 1].id : null;
      return { rows, total, cursor: nextCursor };
    },

    async get(id: string): Promise<T | null> {
      try {
        const raw = await dataFetch(`${rowsPath}/${encodeURIComponent(id)}`, {}, readableSignedOut);
        return raw ? (hydrateRow(raw) as unknown as T) : null;
      } catch (err) {
        if (err instanceof BackendError && err.status === 404) return null;
        throw err;
      }
    },

    async create(data: Record<string, unknown>): Promise<T> {
      if (companyScoped) return hydrateRow(await companyWrite("POST", companyRows, data)) as unknown as T;
      const takesSignedOut = config.tables[table] === "public_create";
      if (takesSignedOut && !auth.isAuthenticated()) {
        return hydrateRow(await submitSignedOut(table, data)) as unknown as T;
      }
      try {
        // No permissions field — table defaults apply (see access mode).
        const raw = await dataFetch(rowsPath, {
          method: "POST",
          body: JSON.stringify({ rowId: "unique()", data: serialize(data) }),
        });
        return hydrateRow(raw ?? {}) as unknown as T;
      } catch (err) {
        // The stored sign-in was refused before anything was written, and that
        // cleared it: a public_create row is still welcome from a signed-out visitor.
        if (takesSignedOut && err instanceof AuthError && err.status === 401) {
          return hydrateRow(await submitSignedOut(table, data)) as unknown as T;
        }
        throw err;
      }
    },

    async update(id: string, data: Record<string, unknown>): Promise<T> {
      if (companyScoped) {
        return hydrateRow(await companyWrite("PATCH", `${companyRows}/${encodeURIComponent(id)}`, data)) as unknown as T;
      }
      const raw = await dataFetch(`${rowsPath}/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ data: serialize(data) }),
      });
      return hydrateRow(raw ?? {}) as unknown as T;
    },

    async upsert(id: string, data: Record<string, unknown>): Promise<T> {
      if (companyScoped) throw refusal(409, "company_table", "upsert() is not available on a company table; use create() or update()");
      // No permissions field, as create(): a new row gets the signed-in user as its owner,
      // an existing row keeps its own grants.
      const raw = await dataFetch(`${rowsPath}/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: JSON.stringify({ data: serialize(data) }),
      });
      return hydrateRow(raw ?? {}) as unknown as T;
    },

    async increment(id: string, column: string, by = 1, options: { max?: number } = {}): Promise<T> {
      if (companyScoped) throw refusal(409, "company_table", "counters are not available on a company table");
      const raw = await changeCounter(`${rowsPath}/${encodeURIComponent(id)}`, column, "increment", by, options.max);
      return hydrateRow(raw) as unknown as T;
    },

    async decrement(id: string, column: string, by = 1, options: { min?: number } = {}): Promise<T> {
      if (companyScoped) throw refusal(409, "company_table", "counters are not available on a company table");
      const raw = await changeCounter(`${rowsPath}/${encodeURIComponent(id)}`, column, "decrement", by, options.min);
      return hydrateRow(raw) as unknown as T;
    },

    async remove(id: string): Promise<void> {
      await dataFetch(`${rowsPath}/${encodeURIComponent(id)}`, { method: "DELETE" });
    },

    async bulkCreate(rows: Record<string, unknown>[], options: BulkImportOptions = {}): Promise<BulkImportResult> {
      if (!Array.isArray(rows) || rows.length === 0) {
        throw refusal(400, "invalid_request", "bulkCreate needs a non-empty array of rows");
      }
      const mode = options.mode ?? "insert";
      const requested = Math.floor(Number(options.chunkSize ?? BULK_IMPORT_MAX_CHUNK));
      const chunkSize = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), BULK_IMPORT_MAX_CHUNK) : BULK_IMPORT_MAX_CHUNK;
      if (options.importKey !== undefined && !BULK_IMPORT_KEY_PATTERN.test(options.importKey)) {
        throw refusal(400, "invalid_request", "importKey must be 1-56 letters, digits, '.', '_', ':' or '-'");
      }
      const result: BulkImportResult = { created: 0, updated: 0, failed: 0, errors: [] };
      for (let start = 0, chunk = 0; start < rows.length; start += chunkSize, chunk++) {
        const slice = rows.slice(start, start + chunkSize).map((row) => serialize(row));
        const key = options.importKey ? `${options.importKey}:${chunk}` : undefined;
        const answer = await importChunk(table, slice, mode, key);
        result.created += answer.created;
        result.updated += answer.updated;
        result.failed += answer.failed;
        for (const error of answer.errors ?? []) result.errors.push({ index: start + error.index, reason: error.reason });
        options.onProgress?.({
          sent: Math.min(start + chunkSize, rows.length),
          total: rows.length,
          created: result.created,
          updated: result.updated,
          failed: result.failed,
        });
      }
      return result;
    },

    subscribe(callback: (event: RealtimeEvent<T>) => void): Unsubscribe {
      return subscribeToTable(table, callback as unknown as (event: RealtimeEvent) => void);
    },

    subscribeRow(id: string, callback: (event: RealtimeEvent<T>) => void): Unsubscribe {
      return subscribeToRow(table, id, callback as unknown as (event: RealtimeEvent) => void);
    },
  };
}
