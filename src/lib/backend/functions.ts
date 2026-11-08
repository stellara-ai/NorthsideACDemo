// Server functions for the app backend: call a deployed function by name, or as plain
// HTTP (functions.fetch, e.g. a tRPC server in one function).

import { auth, AuthError } from "./auth";
import { functionIdPrefix } from "./config";
import { resourceSlug } from "./ids";
import { apiBase, platformBase, visitorHeaders, WIRE_HEADERS } from "./data";
import type { FunctionResult } from "./types";

export interface CallOptions {
  /** Request body forwarded to the function (object is JSON-encoded). */
  body?: unknown;
  /** Path the function sees (e.g. "/report"). */
  path?: string;
  /** HTTP method the function sees (default POST). */
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
}

/**
 * The id the backend runs a function under. A function's name (the name it was deployed
 * with, or the slug the backend tools print) maps to this app's id exactly as the server
 * builds it: lowercase, every run of other characters a hyphen, at most 12 characters. A
 * full id passes through, with the same rule applied to what follows the prefix.
 */
function functionId(name: string): string {
  if (functionIdPrefix.length === 0) return name;
  const rest = name.startsWith(functionIdPrefix) ? name.slice(functionIdPrefix.length) : name;
  return `${functionIdPrefix}${resourceSlug(rest)}`;
}

export const functions = {
  /**
   * The platform URL of a function called as plain HTTP: `<platform>/fn/<name>`. Every
   * path under it reaches the same function (req.path is the rest, e.g. "/greeting").
   * Use it as tRPC's `url` together with `fetch` below.
   */
  url(name: string): string {
    return `${platformBase()}/fn/${encodeURIComponent(name)}`;
  },

  /**
   * Call a function as a plain HTTP request and get the real `Response` back, with the
   * handler's own status, body and content type (JSON, plain text or form data; any
   * other type arrives as plain text). Works as the `fetch` option of tRPC's
   * httpBatchLink. `input` is a path ("/greeting?name=Sam") or a full URL that starts
   * with `functions.url(name)`; any other URL is refused, so the sign-in never leaves
   * for another host. With someone signed in the function runs as them (it sees
   * `x-appwrite-user-id`); with nobody signed in only a function deployed with access
   * "public" runs, any other answers 401 `sign_in_required`.
   */
  async fetch(name: string, input: string | URL = "/", init: RequestInit = {}): Promise<Response> {
    const base = functions.url(name);
    const raw = String(input);
    let target: string;
    if (raw.startsWith(`${base}/`) || raw === base || raw.startsWith(`${base}?`)) target = raw;
    else if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) throw new Error(`functions.fetch only calls ${base}`);
    else target = `${base}${raw.startsWith("/") ? "" : "/"}${raw}`;
    const headers = new Headers(init.headers);
    const session = auth.currentSession();
    if (session && auth.isAuthenticated()) headers.set("Authorization", `Bearer ${session.session}`);
    else headers.delete("Authorization");
    return fetch(target, { ...init, headers });
  },

  /**
   * Invoke a deployed server function and return its result. `name` is the
   * function's slug as the backend tools print it (e.g. "send-report"); the
   * helper maps it to the function id. The function runs with the current
   * signed-in user's context (its forwarded token); with nobody signed in it runs
   * anonymously, which only a function deployed with access "public" accepts.
   */
  async call(name: string, options: CallOptions = {}): Promise<FunctionResult> {
    const headers: Record<string, string> = {
      ...(await visitorHeaders()),
      "Content-Type": "application/json",
    };
    const payload: Record<string, unknown> = {};
    if (options.body !== undefined) {
      payload.body = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
    }
    if (options.path !== undefined) payload.path = options.path;
    if (options.method !== undefined) payload.method = options.method;

    const res = await fetch(
      `${apiBase()}/functions/${encodeURIComponent(functionId(name))}/executions`,
      { method: "POST", headers, body: JSON.stringify(payload) },
    );
    if (!res.ok) {
      // Nobody signed in and the function is not public: the AuthError(401) a signed-out call always got.
      if (res.status === 401 && !(WIRE_HEADERS.jwt in headers)) throw new AuthError(401);
      const text = await res.text().catch(() => "");
      throw new Error(text.length > 0 ? text : `function_call_failed_${res.status}`);
    }
    const raw = (await res.json()) as Record<string, unknown>;
    const responseBody = raw["responseBody"];
    let body: unknown = responseBody;
    if (typeof responseBody === "string") {
      try {
        body = JSON.parse(responseBody);
      } catch {
        body = responseBody;
      }
    }
    return {
      status: String(raw["status"] ?? ""),
      responseStatusCode: Number(raw["responseStatusCode"] ?? 0),
      body,
    };
  },
};
