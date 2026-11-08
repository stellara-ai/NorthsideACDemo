// Reading the platform's refusal of an upload past the signed-in user's storage limit.
//
// Its own module, which every run of the setup tool writes: setup refreshes a helper file nobody
// edited and keeps an edited one, so index.ts must not need anything new from files.ts or types.ts.

import { BackendError } from "./data";

/** The figures of a refused upload (413 storage_limit_exceeded), read with readStorageLimitError(err). */
export interface StorageLimitExceeded {
  limit_bytes: number;
  used_bytes: number;
  file_bytes: number;
}

/**
 * The figures of an upload the platform refused for the user's storage limit (413 storage_limit_exceeded):
 * what the limit is, what they hold and the file's size, in bytes. null for any other error.
 */
export function readStorageLimitError(err: unknown): StorageLimitExceeded | null {
  if (!(err instanceof BackendError) || err.status !== 413) return null;
  try {
    const body = JSON.parse(err.message) as Partial<StorageLimitExceeded> & { error?: unknown };
    if (body.error !== "storage_limit_exceeded") return null;
    const n = (v: unknown) => (typeof v === "number" ? v : 0);
    return { limit_bytes: n(body.limit_bytes), used_bytes: n(body.used_bytes), file_bytes: n(body.file_bytes) };
  } catch {
    return null;
  }
}
