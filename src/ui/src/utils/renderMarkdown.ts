import type { ReactNode } from "react";
import { createElement, Fragment } from "react";

/**
 * Convert a subset of standard markdown to React elements.
 * Handles: bold, italic, inline code, links, horizontal rules, and line breaks.
 */
export function renderMarkdown(md: string): ReactNode {
  const lines = md.split("\n");
  const elements: ReactNode[] = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    if (i > 0) elements.push(createElement("br", { key: `br-${i}` }));

    if (/^-{3,}$/.test(trimmed)) {
      elements.push(createElement("hr", { key: `hr-${i}` }));
      continue;
    }

    if (trimmed === "") continue;
    elements.push(createElement(Fragment, { key: `line-${i}` }, ...parseInline(trimmed)));
  }

  return createElement(Fragment, null, ...elements);
}

// Regex that matches markdown tokens: links, bold, italic, code
const TOKEN_RE =
  /\[([^\]]+)\]\((https?:\/\/[^)]+)\)|\*\*([^*]+)\*\*|(?<![/\w])_([^_\n]+)_(?![/\w])|`([^`]+)`/g;

function parseInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  TOKEN_RE.lastIndex = 0;
  match = TOKEN_RE.exec(text);
  while (match !== null) {
    // Push preceding plain text
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }

    if (match[1] != null && match[2] != null) {
      // Link: [text](url)
      nodes.push(
        createElement(
          "a",
          { key: `a-${key++}`, href: match[2], target: "_blank", rel: "noopener noreferrer" },
          match[1],
        ),
      );
    } else if (match[3] != null) {
      // Bold: **text**
      nodes.push(createElement("strong", { key: `b-${key++}` }, match[3]));
    } else if (match[4] != null) {
      // Italic: _text_
      nodes.push(createElement("em", { key: `i-${key++}` }, match[4]));
    } else if (match[5] != null) {
      // Code: `text`
      nodes.push(createElement("code", { key: `c-${key++}` }, match[5]));
    }

    lastIndex = match.index + match[0].length;
    match = TOKEN_RE.exec(text);
  }

  // Remaining plain text
  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}

/**
 * HTML string version for testing purposes.
 */
export function markdownToHtml(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^-{3,}$/.test(trimmed)) {
      out.push("<hr/>");
      continue;
    }
    out.push(inlineToHtml(trimmed || "<br/>"));
  }

  return out.join("<br/>");
}

function inlineToHtml(text: string): string {
  if (text === "<br/>") return text;
  return text
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(?<![/\w])_([^_\n]+)_(?![/\w])/g, "<em>$1</em>")
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
    );
}
