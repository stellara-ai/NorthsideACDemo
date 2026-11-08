// File storage for the app backend: upload files, build view URLs, and download a file's bytes.

import { auth, AuthError } from "./auth";
import { bucketIdPrefix, config, enforcedBuckets } from "./config";
import { resourceSlug } from "./ids";
import { apiBase, authHeaders, BackendError } from "./data";
import type { StorageUsage, UploadedFile } from "./types";

export interface UploadOptions {
  /** Override the stored filename (defaults to the File's name). */
  name?: string;
  /** Provide a specific file id (defaults to a server-generated one). */
  fileId?: string;
  /** company_members buckets: the company the file belongs to (a member's only company when omitted). */
  companyId?: string;
  /** company_members buckets: only staff of the company see the file. */
  staffOnly?: boolean;
}

/**
 * Post a multipart upload to one of the platform's upload routes (the auth URL's sibling), as the signed-in
 * user. Waits for the sign-in from the platform menu first, as usage() and every data call do, so a file is
 * never stored under the previous person's session.
 */
async function postUploadForm(appPath: string, form: FormData): Promise<Record<string, unknown>> {
  await auth.ready();
  const session = auth.currentSession();
  if (!session || session.expires_at * 1000 <= Date.now()) throw new AuthError(401);
  const appBase = config.authBaseUrl.replace(/\/+$/, "").replace(/\/auth$/, "");
  const res = await fetch(`${appBase}${appPath}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${session.session}` },
    body: form,
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

/** Upload to a company bucket: through the platform, which grants the file to its company. */
async function uploadToCompanyBucket(bucketName: string, file: File | Blob, name: string, options: UploadOptions): Promise<string> {
  const form = new FormData();
  form.append("file", file, name);
  if (options.companyId) form.append("company_id", options.companyId);
  if (options.staffOnly) form.append("staff_only", "true");
  // The platform's route takes the bucket's NAME; it maps the id itself.
  const raw = await postUploadForm(`/company/buckets/${encodeURIComponent(bucketName)}/files`, form);
  return String(raw["$id"] ?? "");
}

/**
 * Upload to a bucket whose limit the platform enforces: the platform refuses a file that would take the
 * signed-in user past their storage limit (BackendError 413, readStorageLimitError(err) has the figures),
 * and stores one within it with the user's own grants, as a direct upload would.
 */
async function uploadToEnforcedBucket(bucketName: string, file: File | Blob, name: string, options: UploadOptions): Promise<Record<string, unknown>> {
  const form = new FormData();
  form.append("file", file, name);
  if (options.fileId) form.append("file_id", options.fileId);
  // The upload is the person's who asked for it: another sign-in before its turn cancels it.
  await auth.ready();
  const askedAs = auth.currentSession()?.session ?? null;
  return await oneEnforcedUploadAtATime(() => {
    if ((auth.currentSession()?.session ?? null) !== askedAs) throw new AuthError(401);
    return postUploadForm(`/buckets/${encodeURIComponent(bucketName)}/files`, form);
  });
}

/**
 * How long an enforced upload waits at most for the one before it, counted from when that one began or
 * this one was queued, whichever is later: an upload whose connection stalls and never settles must not
 * hold the queue for ever.
 */
const ENFORCED_UPLOAD_WAIT_MS = 120_000;

/** This tab's last enforced upload (when it began, and how it ends): the platform checks one upload per user at a time. */
let lastEnforcedUpload: { begun: Promise<void>; run: Promise<unknown> } | null = null;

/** Resolves when `upload` settles, or ENFORCED_UPLOAD_WAIT_MS after this is called when it never does. */
function settledOrWaitedOut(upload: Promise<unknown>): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ENFORCED_UPLOAD_WAIT_MS);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    upload.then(done, done);
  });
}

/** Run an enforced upload after the ones before it, so uploading several files at once is never refused for it. */
function oneEnforcedUploadAtATime<T>(upload: () => Promise<T>): Promise<T> {
  const before = lastEnforcedUpload;
  // The wait for the upload before this one counts from the later of when that one began and when this
  // one was queued: counted from the queueing alone, every upload of a long queue would start together
  // once the first wait ran out; from the start alone, one queued later would start beside a slow one.
  const turn = before ? before.begun.then(() => settledOrWaitedOut(before.run)) : Promise.resolve();
  let started: () => void = () => undefined;
  const begun = new Promise<void>((resolve) => {
    started = resolve;
  });
  const run = turn.then(() => {
    started();
    return upload();
  });
  lastEnforcedUpload = { begun, run };
  return run;
}

/** The slug the backend knows a bucket by, from its name or its full id. */
function bucketSlug(bucket: string): string {
  if (bucketIdPrefix.length > 0 && bucket.startsWith(bucketIdPrefix)) return bucket.slice(bucketIdPrefix.length);
  return resourceSlug(bucket);
}

/** Whether uploads to this bucket go through the platform's storage-limit check (enforcedBuckets in config.ts). */
function isEnforcedBucket(bucket: string): boolean {
  return enforcedBuckets.includes(bucketSlug(bucket));
}

/**
 * The id the backend stores a bucket under. A bucket's name (as the backend tools took it)
 * maps to this app's id exactly as the server builds it: lowercase, every run of other
 * characters a hyphen, at most 12 characters. A full id passes through unchanged.
 */
function bucketId(bucket: string): string {
  if (bucketIdPrefix.length === 0 || bucket.startsWith(bucketIdPrefix)) return bucket;
  return `${bucketIdPrefix}${resourceSlug(bucket)}`;
}

/** The storage path of one stored file, under the bucket's id. */
function filePath(bucket: string, fileId: string): string {
  return (
    `${apiBase()}/storage/buckets/${encodeURIComponent(bucketId(bucket))}` +
    `/files/${encodeURIComponent(fileId)}`
  );
}

/**
 * The view URL of a stored file. A plain link or <img> sends no sign-in, so this URL opens
 * only for a file in a public_read bucket; read a file from any other bucket with download().
 */
export function fileUrl(bucket: string, fileId: string): string {
  return `${filePath(bucket, fileId)}/view?project=${encodeURIComponent(config.projectId)}`;
}

export const files = {
  /**
   * Upload a File/Blob to a bucket (by its name) and return its id, name, and view URL.
   * On a bucket the owner marked "Enforce the limit on uploads" it goes through the platform,
   * which refuses a file past the user's limit: BackendError 413, readStorageLimitError(err).
   */
  async upload(bucket: string, file: File | Blob, options: UploadOptions = {}): Promise<UploadedFile> {
    if (config.buckets?.[bucket] === "company_members") {
      const name = options.name ?? (file instanceof File ? file.name : "upload");
      const id = await uploadToCompanyBucket(bucket, file, name, options);
      // A company file opens with download(); url() opens only public_read files.
      return { id, name, url: fileUrl(bucket, id) };
    }
    if (isEnforcedBucket(bucket)) {
      const name = options.name ?? (file instanceof File ? file.name : "upload");
      const raw = await uploadToEnforcedBucket(bucket, file, name, options);
      const id = String(raw["$id"] ?? "");
      return { id, name: String(raw["name"] ?? name), url: fileUrl(bucket, id) };
    }
    const form = new FormData();
    form.append("fileId", options.fileId ?? "unique()");
    const name = options.name ?? (file instanceof File ? file.name : "upload");
    form.append("file", file, name);

    // Auth headers only — the browser sets the multipart Content-Type + boundary.
    const headers = await authHeaders();
    const res = await fetch(`${apiBase()}/storage/buckets/${encodeURIComponent(bucketId(bucket))}/files`, {
      method: "POST",
      headers,
      body: form,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(text.length > 0 ? text : `upload_failed_${res.status}`);
    }
    const raw = (await res.json()) as Record<string, unknown>;
    const id = String(raw["$id"] ?? "");
    return { id, name: String(raw["name"] ?? name), url: fileUrl(bucket, id) };
  },

  /** View URL for an already-uploaded file (it opens without sign-in only on a public_read bucket). */
  url: fileUrl,

  /**
   * A stored file's bytes, read as the signed-in user. Show or save it with
   * URL.createObjectURL(blob). With nobody signed in it throws AuthError (status 401)
   * before any request, as upload() does; a file in a public_read bucket opens with url().
   * A refusal throws BackendError with the server's status (404: no such file for this user).
   */
  async download(bucket: string, fileId: string): Promise<Blob> {
    const res = await fetch(`${filePath(bucket, fileId)}/download`, { headers: await authHeaders() });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new BackendError(res.status, text);
    }
    return await res.blob();
  },

  /**
   * What the signed-in user stores in this app's buckets, their limit and what is left, in bytes.
   * The platform measures at most once a minute, so the numbers are normally a minute old
   * (measured_at): ask right before each upload and count your own recent uploads on top of it
   * (the storage doc, Usage and limits).
   * Waits for the sign-in from the platform menu, as me() does. With nobody signed in it throws
   * AuthError (status 401) before any request; any other refusal throws BackendError.
   */
  async usage(): Promise<StorageUsage> {
    await auth.ready();
    const session = auth.currentSession();
    if (!session || session.expires_at * 1000 <= Date.now()) throw new AuthError(401);
    // The platform's route (the auth URL's sibling), as the company upload uses.
    const appBase = config.authBaseUrl.replace(/\/+$/, "").replace(/\/auth$/, "");
    const res = await fetch(`${appBase}/storage/me`, {
      headers: { Authorization: `Bearer ${session.session}` },
    });
    if (res.status === 401) {
      await auth.logout();
      throw new AuthError(401);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new BackendError(res.status, text);
    }
    return (await res.json()) as StorageUsage;
  },
};
