// End-user authentication for the app backend.
//
// Talks only to OUR auth endpoints (never the backend vendor). The long-lived
// session is stored in localStorage under `app_session`; short-lived data tokens
// (for reads/writes and realtime) are exchanged on demand and cached in memory,
// refreshed at least 60s before they expire.
//
// Shown inside the platform menu (in a frame) with the menu item's "Sign users in"
// switch on, the app signs the person signed in to the platform in by itself: it asks the
// parent page for the signed token the menu holds, exchanges it here for the app's
// normal session, and `me()` waits for that before it answers. Opened directly,
// nothing changes.

import { config } from "./config";
import type { AppUser, DataToken, EmbedSignInOutcome, IdentityToken, Session } from "./types";

const SESSION_KEY = "app_session";
/** Refresh the data token this many seconds before it actually expires. */
const REFRESH_MARGIN_SECONDS = 60;
/**
 * Dev-preview auto-login parameter. The assistant appends a short-lived session
 * token to the preview URL when it screenshots a login-gated page; this module
 * consumes it on load and removes it from the address bar. Nothing in the app
 * reads or writes it. It is consumed only when no live sign-in is stored, so a
 * shared preview link can never replace a real login, and the platform redacts
 * the parameter from every preview-debug capture.
 */
const PREVIEW_SESSION_PARAM = "__preview_session";
/** The platform menu's sign-in messages (its embed SSO protocol; never rename these). */
const EMBED_SSO_REQUEST = { source: "votel-embed-sso", type: "request" } as const;
const EMBED_SSO_HOST_SOURCE = "votel-embed-sso-host";
/** How long page load waits for the platform menu to offer a sign-in before it carries on. */
const EMBED_SSO_OFFER_WAIT_MS = 3000;
/** How long the exchange itself may take before the app carries on without it. */
const EMBED_SSO_EXCHANGE_WAIT_MS = 10000;

let cachedDataToken: DataToken | null = null;
let inflightDataToken: Promise<string> | null = null;
/** The last identity token, kept with the session it was minted for (a new sign-in never reuses it). */
let cachedIdentityToken: { session: string; token: IdentityToken } | null = null;
/** The identity-token request in flight, with the session it asks for (a sign-in meanwhile never shares it). */
let inflightIdentityToken: { session: string; promise: Promise<IdentityToken> } | null = null;
/** The session, kept here only when the browser refuses this frame its storage. */
let memorySession: Session | null = null;
/** How the sign-in from the platform menu ended; null while it is still running. */
let embedOutcome: EmbedSignInOutcome | null = null;
/** Counts session writes, so a slow menu sign-in never undoes a login or logout made meanwhile. */
let sessionWrites = 0;

/** Thrown on any auth failure; `status` carries the HTTP status. */
export class AuthError extends Error {
  readonly status: number;
  constructor(status: number, message?: string) {
    super(message ?? `auth_error_${status}`);
    this.status = status;
    this.name = "AuthError";
  }
}

function authUrl(path: string): string {
  return `${config.authBaseUrl.replace(/\/+$/, "")}/${path}`;
}

function hasLocalStorage(): boolean {
  try {
    // Reading `localStorage` itself throws in a frame whose storage the browser blocks.
    return typeof localStorage !== "undefined";
  } catch {
    return false;
  }
}

function readSession(): Session | null {
  if (memorySession) return memorySession;
  if (!hasLocalStorage()) return null;
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

function writeSession(session: Session | null): void {
  sessionWrites += 1;
  memorySession = null;
  try {
    if (!hasLocalStorage()) throw new Error("no storage");
    if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    // Private mode or blocked frame storage: keep the session for this page's life.
    memorySession = session;
  }
}

/** Base64url-decode a JWT segment (browser-safe, no Buffer). */
function decodeBase64Url(segment: string): string {
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/");
  const withPad = padded + "=".repeat((4 - (padded.length % 4)) % 4);
  return atob(withPad);
}

/** A JWT's claims, decoded WITHOUT verifying it, or null. */
function readJwtClaims(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const claims = JSON.parse(decodeBase64Url(parts[1])) as unknown;
    return claims && typeof claims === "object" ? (claims as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Read the `exp` (epoch seconds) claim from a JWT, or null. */
function readJwtExpiry(token: string): number | null {
  const exp = readJwtClaims(token)?.exp;
  return typeof exp === "number" ? exp : null;
}

/**
 * Build the stored session shape from a bare, UNEXPIRED session JWT (preview
 * auto-login). Returns null for anything malformed or already past its `exp` —
 * a preview link opened hours later must not install a dead session. The result
 * is marked `preview: true` so a real sign-in is never mistaken for one.
 */
function sessionFromToken(token: string): Session | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const claims = JSON.parse(decodeBase64Url(parts[1])) as {
      sub?: unknown;
      exp?: unknown;
      email?: unknown;
      labels?: unknown;
    };
    if (typeof claims.sub !== "string" || typeof claims.exp !== "number") return null;
    if (claims.exp * 1000 <= Date.now()) return null;
    return {
      session: token,
      expires_at: claims.exp,
      // A preview token carries no realtime session; live updates stay signed
      // out until the user logs in normally.
      realtime_secret: null,
      vendor_session_id: null,
      preview: true,
      user: {
        id: claims.sub,
        email: typeof claims.email === "string" ? claims.email : null,
        name: null,
        labels: Array.isArray(claims.labels) ? (claims.labels as string[]) : [],
        verified: true,
        company_access_level: null,
        company_ids: [],
      },
    };
  } catch {
    return null;
  }
}

/** True when a real (non-preview) sign-in is stored and has not expired. */
function hasLiveLoginSession(): boolean {
  const session = readSession();
  return session !== null && session.preview !== true && session.expires_at * 1000 > Date.now();
}

/**
 * Consume a `__preview_session` token from the current URL, once, at module init.
 *
 * The token becomes the active session only when NO live sign-in is stored, so
 * opening a shared preview link never swaps a 30-day login for a <= 10-minute
 * preview one (an expired token is ignored outright). A stored preview session
 * may be replaced by a newer preview token, and a screenshot browser starts with
 * an empty store, so captures keep working.
 *
 * The parameter is stripped from the address bar in EVERY case — token installed
 * or not — so it is never kept in history, copied out of the URL bar, or sent as
 * a referrer.
 */
function consumePreviewSession(): void {
  if (typeof window === "undefined" || !window.location) return;
  const params = new URLSearchParams(window.location.search);
  const token = params.get(PREVIEW_SESSION_PARAM);
  if (!token) return;
  if (!hasLiveLoginSession()) {
    const session = sessionFromToken(token);
    if (session) {
      writeSession(session);
      cachedDataToken = null;
    }
  }
  params.delete(PREVIEW_SESSION_PARAM);
  const query = params.toString();
  const cleaned = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
  try {
    window.history.replaceState(window.history.state, "", cleaned);
  } catch {
    // Some embedded contexts forbid history writes; the session is stored either way.
  }
}

consumePreviewSession();

/** True on the app's own dev server (the builder's preview), which no menu ever shows. */
function isDevServer(): boolean {
  try {
    return (import.meta as unknown as { env?: { DEV?: unknown } }).env?.DEV === true;
  } catch {
    return false;
  }
}

/** True when the app runs inside a frame (the platform menu shows it in one). */
function isFramed(): boolean {
  if (typeof window === "undefined" || !window.parent || typeof window.addEventListener !== "function") {
    return false;
  }
  try {
    return window.self !== window.top;
  } catch {
    // A cross-origin `top` may throw on access: only a framed page sees that.
    return true;
  }
}

/** The `error` code of a refused answer, or undefined. */
async function readErrorCode(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { error?: unknown };
    return typeof body.error === "string" ? body.error : undefined;
  } catch {
    return undefined;
  }
}

/** The person a menu token names, and what the sign-in it started may still change. */
interface EmbedOffer {
  /** The platform user id (`sub`) the token names. */
  userId: string;
  /** The email the token names; used only for a session that holds no `sso_user_id`. */
  email: string;
  /** `sessionWrites` when the exchange began: a write since is the newer word. */
  writesAtStart: number;
  /** False once page load stopped waiting for this sign-in (it timed out). */
  awaited: () => boolean;
}

/** Codes that refuse the PERSON; any other refusal can be a moment's failure on our side. */
const PERSON_REFUSED_CODES = ["wrong_app", "account_disabled", "login_as_refused", "embed_sso_off", "no_app_account"];

/**
 * After a menu sign-in that did not sign anyone in, keep no session of somebody else.
 *
 * Clears a stored session of a person other than the one the menu says is signed in
 * now (by platform user id when the session came from a menu sign-in, else by email),
 * and, when the person themselves was refused, the session a menu sign-in made for
 * them. A password sign-in of the same person is kept. Nothing is cleared when the
 * session was written since the sign-in began (a login or logout meanwhile is newer).
 */
function dropSessionNotOf(offer: EmbedOffer, personRefused: boolean): void {
  if (sessionWrites !== offer.writesAtStart) return;
  const stored = readSession();
  if (!stored) return;
  const samePerson = stored.sso_user_id
    ? stored.sso_user_id === offer.userId
    : (stored.user.email ?? "").toLowerCase() === offer.email.toLowerCase();
  if (!samePerson || (personRefused && stored.sso === true)) {
    writeSession(null);
    cachedDataToken = null;
  }
}

/**
 * Exchange the platform menu's token for this app's session.
 *
 * Whatever the answer, the previous person on this browser is never left signed in
 * (`dropSessionNotOf`). A session is written only while page load still waits for it
 * and nothing else wrote one since the exchange began.
 */
async function exchangeEmbedToken(token: string, offer: EmbedOffer): Promise<EmbedSignInOutcome> {
  let res: Response;
  try {
    res = await fetch(authUrl("embed-sso"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
  } catch {
    dropSessionNotOf(offer, false);
    return { status: "unavailable" };
  }
  if (res.ok) {
    try {
      const session = (await res.json()) as Session;
      if (sessionWrites !== offer.writesAtStart || !offer.awaited()) return { status: "unavailable" };
      writeSession({ ...session, sso: true, sso_user_id: offer.userId });
      cachedDataToken = null;
      return { status: "signed_in" };
    } catch {
      dropSessionNotOf(offer, false);
      return { status: "unavailable" };
    }
  }
  const error = await readErrorCode(res);
  if (res.status >= 500 || res.status === 429) {
    dropSessionNotOf(offer, false);
    return { status: "unavailable", error };
  }
  dropSessionNotOf(offer, PERSON_REFUSED_CODES.includes(error ?? ""));
  console.warn(`Sign-in from the menu was refused (${error ?? res.status}).`);
  return { status: "refused", error };
}

/**
 * The sign-in from the platform menu, started once at module init. Resolves with the
 * stored session (or null) when the exchange finished or failed, when no token came
 * within EMBED_SSO_OFFER_WAIT_MS, or at once when the app is not in a frame.
 *
 * It runs on every framed page load, even with a session stored: the menu offers a
 * fresh token each time, and exchanging it is what keeps the app signed in as the
 * person signed in to the platform now.
 */
function startEmbedSignIn(): Promise<Session | null> {
  if (!isFramed() || isDevServer()) {
    embedOutcome = { status: "not_framed" };
    return Promise.resolve(readSession());
  }
  return new Promise((resolve) => {
    let settled = false;
    let exchanging = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (outcome: EmbedSignInOutcome): void => {
      if (settled) return;
      settled = true;
      embedOutcome = outcome;
      window.removeEventListener("message", onMessage);
      if (timer !== undefined) clearTimeout(timer);
      resolve(readSession());
    };
    const onMessage = (event: MessageEvent): void => {
      if (settled || exchanging || event.source !== window.parent) return;
      const data = event.data as { source?: unknown; type?: unknown; token?: unknown } | null;
      if (!data || data.source !== EMBED_SSO_HOST_SOURCE || data.type !== "auth" || typeof data.token !== "string") {
        return;
      }
      const claims = readJwtClaims(data.token);
      // The server verifies the token; this only stops a genuine token replayed from
      // another page: the menu stamps the address it was opened on as `iss`.
      const issuer = typeof claims?.iss === "string" ? claims.iss : "";
      if (issuer && issuer.toLowerCase() !== String(event.origin).toLowerCase()) return;
      exchanging = true;
      const offer: EmbedOffer = {
        userId: typeof claims?.sub === "string" ? claims.sub : "",
        email: typeof claims?.user_email === "string" ? claims.user_email : "",
        writesAtStart: sessionWrites,
        awaited: () => !settled,
      };
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        dropSessionNotOf(offer, false);
        finish({ status: "unavailable" });
      }, EMBED_SSO_EXCHANGE_WAIT_MS);
      void exchangeEmbedToken(data.token, offer).then(finish);
    };
    // Listen before asking: the menu also posts the token when the frame loads.
    window.addEventListener("message", onMessage);
    timer = setTimeout(() => finish({ status: "no_offer" }), EMBED_SSO_OFFER_WAIT_MS);
    try {
      // Nothing secret is asked for, and the menu answers only its own frame.
      window.parent.postMessage(EMBED_SSO_REQUEST, "*");
    } catch {
      // The menu still posts the token on frame load.
    }
  });
}

const embedSignInReady: Promise<Session | null> = startEmbedSignIn();

async function postJson<T>(url: string, body: unknown, bearer?: string): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (bearer) headers["Authorization"] = `Bearer ${bearer}`;
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) throw new AuthError(res.status);
  return (await res.json()) as T;
}

export const auth = {
  /** Register a new user and start a session. Throws AuthError 403 ("signup_closed")
   *  when the app does not take public sign-ups: its accounts are created by the owner,
   *  and AuthError 400 ("invalid_email") when the email is not an email address. */
  async signup(email: string, password: string, name?: string): Promise<Session> {
    let session: Session;
    try {
      session = await postJson<Session>(authUrl("signup"), { email, password, name });
    } catch (err) {
      if (err instanceof AuthError && err.status === 403) throw new AuthError(403, "signup_closed");
      if (err instanceof AuthError && err.status === 400) throw new AuthError(400, "invalid_email");
      throw err;
    }
    writeSession(session);
    cachedDataToken = null;
    return session;
  },

  /** Sign in an existing user and start a session. */
  async login(email: string, password: string): Promise<Session> {
    const session = await postJson<Session>(authUrl("login"), { email, password });
    writeSession(session);
    cachedDataToken = null;
    return session;
  },

  /** Sign out: notify the server (best-effort) and clear local state. */
  async logout(): Promise<void> {
    const session = readSession();
    writeSession(null);
    cachedDataToken = null;
    inflightDataToken = null;
    if (session) {
      try {
        await fetch(authUrl("logout"), {
          method: "POST",
          headers: {
            Authorization: `Bearer ${session.session}`,
            "Content-Type": "application/json",
          },
          // Echo the session id so the server revokes the realtime session.
          body: JSON.stringify({ vendor_session_id: session.vendor_session_id ?? null }),
        });
      } catch {
        // logout is client-authoritative; ignore network errors
      }
    }
  },

  /**
   * Change the signed-in user's password. The current password is required - a
   * stored session alone is not enough. Returns a refreshed session for THIS
   * device, which is stored automatically.
   *
   * Takes effect for new sign-ins; sessions already open on other devices are not
   * signed out. Throws AuthError 400 (new password too short), 401 (wrong current
   * password, or signed out) or 403 (account disabled).
   */
  async changePassword(currentPassword: string, newPassword: string): Promise<Session> {
    const stored = readSession();
    if (!stored) throw new AuthError(401);
    const session = await postJson<Session>(
      authUrl("change-password"),
      { current_password: currentPassword, new_password: newPassword },
      stored.session,
    );
    writeSession(session);
    // The realtime credential was rotated with the password; drop the cached data
    // token so the next call picks the new one up.
    cachedDataToken = null;
    return session;
  },

  /**
   * Ask for a password-reset email. ALWAYS resolves - the server answers the same
   * way whether or not the address has an account, so never tell the user an
   * address "was not found". Show one confirmation either way.
   *
   * The emailed link opens a page hosted by the platform, so the app needs no
   * reset route of its own.
   */
  async requestPasswordReset(email: string): Promise<void> {
    try {
      await postJson<{ ok: boolean }>(authUrl("forgot-password"), { email });
    } catch {
      // The server always answers 200; a network error must not reveal anything either.
    }
  },

  /**
   * Complete a reset with the token from the emailed link. Does NOT sign the user
   * in - send them to the login screen afterwards.
   *
   * Throws AuthError 400 (password too short) or 401 (link expired or already
   * used), so the UI can tell those two apart.
   */
  async resetPassword(token: string, newPassword: string): Promise<void> {
    await postJson<{ ok: boolean }>(authUrl("reset-password"), {
      token,
      new_password: newPassword,
    });
  },

  /**
   * Resolves once the sign-in from the platform menu is over: signed in, refused, no
   * token offered within 3 seconds, or at once when the app is not shown in a frame.
   * Answers the stored session (or null). `me()` waits for it already.
   */
  ready(): Promise<Session | null> {
    return embedSignInReady;
  },

  /**
   * How the sign-in from the platform menu ended, or null while it is still running:
   * `signed_in`, `not_framed` (opened directly, or on the dev server), `no_offer` (no token came), `refused` (with the
   * server's `error`, e.g. "no_app_account"), or `unavailable` (try again later).
   */
  embedSignIn(): EmbedSignInOutcome | null {
    return embedOutcome;
  },

  /** The currently stored session, or null. */
  currentSession(): Session | null {
    return readSession();
  },

  /** Whether a (non-expired) session is stored locally. */
  isAuthenticated(): boolean {
    const session = readSession();
    if (!session) return false;
    return session.expires_at * 1000 > Date.now();
  },

  /**
   * Fetch the current user's profile from the server, or null if signed out. Waits
   * for the sign-in from the platform menu first, so restoring with `me()` on page load
   * never shows a login screen to someone the menu is signing in.
   */
  async me(): Promise<AppUser | null> {
    await embedSignInReady;
    const session = readSession();
    if (!session) return null;
    const res = await fetch(authUrl("me"), {
      headers: { Authorization: `Bearer ${session.session}` },
    });
    if (res.status === 401) {
      writeSession(null);
      return null;
    }
    if (!res.ok) throw new AuthError(res.status);
    return (await res.json()) as AppUser;
  },

  /**
   * A short-lived signed token saying who the signed-in user is, for the app owner's
   * OWN server (send it as `Authorization: Bearer <token>`). That server verifies it
   * against the app's public key; it grants nothing on this platform. Valid 15
   * minutes; cached and renewed about a minute before it expires. Throws AuthError
   * 401 when nobody is signed in, 403 for a disabled account, 503 to retry.
   */
  async identityToken(): Promise<IdentityToken> {
    await embedSignInReady;
    const session = readSession();
    if (!session) throw new AuthError(401);
    const now = Math.floor(Date.now() / 1000);
    const cached = cachedIdentityToken;
    if (cached && cached.session === session.session && cached.token.expiresAt - REFRESH_MARGIN_SECONDS > now) {
      return cached.token;
    }
    if (inflightIdentityToken && inflightIdentityToken.session === session.session) {
      return inflightIdentityToken.promise;
    }
    const promise = (async () => {
      const res = await fetch(authUrl("identity-token"), {
        method: "POST",
        headers: { Authorization: `Bearer ${session.session}` },
      });
      if (!res.ok) {
        if (cachedIdentityToken?.session === session.session) cachedIdentityToken = null;
        // Clear the stored sign-in only if it is still the one that was refused.
        if ((res.status === 401 || res.status === 403) && readSession()?.session === session.session) {
          writeSession(null);
        }
        throw new AuthError(res.status);
      }
      const data = (await res.json()) as { token: string; expires_at: number };
      const token: IdentityToken = { token: data.token, expiresAt: data.expires_at };
      cachedIdentityToken = { session: session.session, token };
      return token;
    })();
    const inflight = { session: session.session, promise };
    inflightIdentityToken = inflight;
    try {
      return await promise;
    } finally {
      if (inflightIdentityToken === inflight) inflightIdentityToken = null;
    }
  },

  /**
   * Return a valid short-lived data token, exchanging the session if needed.
   * Cached in memory and refreshed >=60s before expiry; concurrent callers
   * share a single in-flight exchange.
   */
  async getDataToken(): Promise<string> {
    // Never a data token for the previous person's session while the menu signs in the current one.
    await embedSignInReady;
    const now = Math.floor(Date.now() / 1000);
    if (cachedDataToken && cachedDataToken.expires_at - REFRESH_MARGIN_SECONDS > now) {
      return cachedDataToken.token;
    }
    if (inflightDataToken) return inflightDataToken;

    inflightDataToken = (async () => {
      const session = readSession();
      if (!session) throw new AuthError(401);
      const res = await fetch(authUrl("token"), {
        method: "POST",
        headers: { Authorization: `Bearer ${session.session}` },
      });
      if (!res.ok) {
        cachedDataToken = null;
        if (res.status === 401 || res.status === 403) writeSession(null);
        throw new AuthError(res.status);
      }
      const data = (await res.json()) as DataToken;
      const expiry = readJwtExpiry(data.token) ?? data.expires_at;
      cachedDataToken = { token: data.token, expires_at: expiry };
      return data.token;
    })();

    try {
      return await inflightDataToken;
    } finally {
      inflightDataToken = null;
    }
  },
};
