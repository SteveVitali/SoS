import type { ReactNode } from "react";
import { createElement, Fragment } from "react";

// Regex that matches markdown tokens: links, bold, italic, code
const TOKEN_PATTERN =
  /\[([^\]]+)\]\((https?:\/\/[^)]+)\)|\*\*([^*]+)\*\*|(?<![/\w])_([^_\n]+)_(?![/\w])|`([^`]+)`/g;

/**
 * Convert a subset of standard markdown to React elements.
 * Handles: bold, italic, inline code, links, horizontal rules, and line breaks.
 */
export function renderMarkdown(md: string): ReactNode {
  const lines = md.split("\n");
  const elements: ReactNode[] = [];
  let prevWasContent = false;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    if (/^-{3,}$/.test(trimmed)) {
      elements.push(createElement("hr", { key: `hr-${i}` }));
      prevWasContent = false;
      continue;
    }

    if (trimmed === "") {
      prevWasContent = false;
      continue;
    }

    if (prevWasContent) elements.push(createElement("br", { key: `br-${i}` }));
    elements.push(createElement(Fragment, { key: `line-${i}` }, ...parseInline(trimmed)));
    prevWasContent = true;
  }

  return createElement(Fragment, null, ...elements);
}

function parseInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;

  for (const match of text.matchAll(TOKEN_PATTERN)) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }

    if (match[1] != null && match[2] != null) {
      nodes.push(
        createElement(
          "a",
          { key: `a-${key++}`, href: match[2], target: "_blank", rel: "noopener noreferrer" },
          match[1],
        ),
      );
    } else if (match[3] != null) {
      nodes.push(createElement("strong", { key: `b-${key++}` }, match[3]));
    } else if (match[4] != null) {
      nodes.push(createElement("em", { key: `i-${key++}` }, match[4]));
    } else if (match[5] != null) {
      nodes.push(createElement("code", { key: `c-${key++}` }, match[5]));
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}
