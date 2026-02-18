export function slugify(text: string, maxLen = 40): string {
  return text
    .toLowerCase()
    .replace(/<@[^>]+>/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen)
    .replace(/-+$/, "");
}
