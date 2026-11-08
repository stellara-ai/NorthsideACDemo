// The slug rule the backend builds resource ids from.

/**
 * The slug of a function or bucket name: lowercase, every run of characters other than a-z
 * and 0-9 a hyphen, no leading or trailing hyphen, at most 12 characters, "r" when nothing
 * is left. The backend builds every function and bucket id from exactly this rule, so a
 * name the app passes reaches the resource the backend tools created.
 */
export function resourceSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 12)
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "r";
}
