// Company members for portal admins (company access, task f7571642): list the app's users with
// their access, create a user in a company, change a user's level, companies, name or ban
// state, remove a user, and email a password-reset link. Only a signed-in user whose
// company_access_level is "admin" may call these; everyone else gets BackendError 403
// (read it with readBackendError from the data module: error "admin_required"). An admin never
// changes their own access, ban or removal ("self_change").

import { auth, AuthError } from "./auth";
import { config } from "./config";
import { BackendError } from "./data";
import type {
  CompanyAccessLevel,
  CompanyMember,
  MemberChange,
  MemberPage,
  MembershipResult,
  NewMember,
} from "./types";

/** The platform's base for this app (the auth URL's parent). */
function platformBase(): string {
  return config.authBaseUrl.replace(/\/+$/, "").replace(/\/auth$/, "");
}

async function adminRequest<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
  const session = auth.currentSession();
  if (!session || session.expires_at * 1000 <= Date.now()) throw new AuthError(401);
  const headers: Record<string, string> = { Authorization: `Bearer ${session.session}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${platformBase()}/company/members${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    await auth.logout();
    throw new AuthError(401);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new BackendError(res.status, text);
  }
  return (await res.json()) as T;
}

function memberPath(userId: string, suffix = ""): string {
  return `/${encodeURIComponent(userId)}${suffix}`;
}

export const companies = {
  /** The app's users with their access, newest first; pass the returned cursor for the next page. */
  listMembers(options: { search?: string; limit?: number; cursor?: string } = {}): Promise<MemberPage> {
    const query = new URLSearchParams();
    if (options.search) query.set("search", options.search);
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    if (options.cursor) query.set("cursor", options.cursor);
    const qs = query.toString();
    return adminRequest<MemberPage>("GET", qs ? `?${qs}` : "");
  },
  /** Create a user with a starting password (hand it over yourself) in a company. */
  createMember(input: NewMember): Promise<CompanyMember> {
    return adminRequest<CompanyMember>("POST", "", input);
  },
  /** Set a user's company access: a level and, for member / company_staff, their companies. */
  setMembership(userId: string, level: CompanyAccessLevel | null, companyIds: string[] = []): Promise<MembershipResult> {
    return adminRequest<MembershipResult>("PUT", memberPath(userId), {
      company_access_level: level,
      company_ids: companyIds,
    });
  },
  /** Change a user's name, ban state or access. */
  updateMember(userId: string, change: MemberChange): Promise<MembershipResult> {
    return adminRequest<MembershipResult>("PUT", memberPath(userId), change);
  },
  /** Remove a user; their records remain. */
  async removeMember(userId: string): Promise<void> {
    await adminRequest<{ ok: boolean }>("DELETE", memberPath(userId));
  },
  /** Email the user a password-reset link (nothing is sent to a user with no password, or a banned one). */
  async sendPasswordReset(userId: string): Promise<void> {
    await adminRequest<{ ok: boolean }>("POST", memberPath(userId, "/password-reset"));
  },
};
