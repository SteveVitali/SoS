/**
 * Shared utility functions for Knowledge Base features.
 */

import type { KBSearchResult } from "./kbTypes.js";

/**
 * Convert a file path like "docs/api/auth.md" into a breadcrumb
 * like "docs > api > auth.md".
 */
export function pathToBreadcrumb(filePath: string): string {
  return filePath.replace(/[/]/g, " > ");
}

/**
 * Build a display-friendly breadcrumb from a KB search result.
 * Uses file_path when available, falling back to source_file.
 */
export function formatPathBreadcrumb(result: KBSearchResult): string {
  const path = result.metadata.file_path || result.source_file;
  return pathToBreadcrumb(path);
}
