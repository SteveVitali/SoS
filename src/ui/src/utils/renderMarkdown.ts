import type { ReactNode } from "react";
import { createElement, Fragment } from "react";

// Regex that matches markdown tokens: links, bold, italic, code
const TOKEN_PATTERN =
  /\[([^\]]+)\]\((https?:\/\/[^)]+)\)|\*\*([^*]+)\*\*|(?<![/\w])_([^_\n]+)_(?![/\w])|`([^`]+)`/g;

// Block-level patterns
const HEADING_RE = /^(#{1,6})\s+(.+)$/;
const ORDERED_LIST_RE = /^\d+[.)]\s+(.+)$/;
const UNORDERED_LIST_RE = /^[-*•]\s+(.+)$/;
const HR_RE = /^-{3,}$/;

type BlockType = "paragraph" | "heading" | "ol" | "ul" | "hr";

interface Block {
  type: BlockType;
  lines: string[];
  level?: number; // heading level (1-6)
}

/**
 * Convert a subset of standard markdown to React elements.
 * Handles: headings, ordered/unordered lists, paragraphs, bold, italic,
 * inline code, links, horizontal rules, and line breaks.
 */
export function renderMarkdown(md: string): ReactNode {
  const blocks = parseBlocks(md);
  const elements: ReactNode[] = [];

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const key = `blk-${i}`;

    switch (block.type) {
      case "hr":
        elements.push(createElement("hr", { key }));
        break;

      case "heading": {
        const tag = `h${block.level || 1}` as keyof HTMLElementTagNameMap;
        elements.push(createElement(tag, { key }, ...parseInline(block.lines[0])));
        break;
      }

      case "ol":
        elements.push(
          createElement(
            "ol",
            { key, style: { margin: "0.5em 0", paddingLeft: "1.5em" } },
            ...block.lines.map((line, j) =>
              createElement("li", { key: `${key}-li-${j}` }, ...parseInline(line)),
            ),
          ),
        );
        break;

      case "ul":
        elements.push(
          createElement(
            "ul",
            { key, style: { margin: "0.5em 0", paddingLeft: "1.5em" } },
            ...block.lines.map((line, j) =>
              createElement("li", { key: `${key}-li-${j}` }, ...parseInline(line)),
            ),
          ),
        );
        break;

      case "paragraph": {
        const inner: ReactNode[] = [];
        for (let j = 0; j < block.lines.length; j++) {
          if (j > 0) inner.push(createElement("br", { key: `${key}-br-${j}` }));
          inner.push(
            createElement(Fragment, { key: `${key}-l-${j}` }, ...parseInline(block.lines[j])),
          );
        }
        elements.push(createElement("p", { key, style: { margin: "0.5em 0" } }, ...inner));
        break;
      }
    }
  }

  return createElement(Fragment, null, ...elements);
}

/**
 * Group source lines into typed blocks separated by blank lines.
 * Consecutive list items of the same type are merged into one block.
 */
function parseBlocks(md: string): Block[] {
  const rawLines = md.split("\n");
  const blocks: Block[] = [];
  let current: Block | null = null;

  const flush = () => {
    if (current) {
      blocks.push(current);
      current = null;
    }
  };

  for (const raw of rawLines) {
    const trimmed = raw.trim();

    // Blank line → flush current block
    if (trimmed === "") {
      flush();
      continue;
    }

    // Horizontal rule
    if (HR_RE.test(trimmed)) {
      flush();
      blocks.push({ type: "hr", lines: [] });
      continue;
    }

    // Heading
    const headingMatch = trimmed.match(HEADING_RE);
    if (headingMatch) {
      flush();
      blocks.push({
        type: "heading",
        lines: [headingMatch[2]],
        level: headingMatch[1].length,
      });
      continue;
    }

    // Ordered list item
    const olMatch = trimmed.match(ORDERED_LIST_RE);
    if (olMatch) {
      if (current?.type === "ol") {
        current.lines.push(olMatch[1]);
      } else {
        flush();
        current = { type: "ol", lines: [olMatch[1]] };
      }
      continue;
    }

    // Unordered list item
    const ulMatch = trimmed.match(UNORDERED_LIST_RE);
    if (ulMatch) {
      if (current?.type === "ul") {
        current.lines.push(ulMatch[1]);
      } else {
        flush();
        current = { type: "ul", lines: [ulMatch[1]] };
      }
      continue;
    }

    // Regular text → paragraph (merge consecutive non-blank lines)
    if (current?.type === "paragraph") {
      current.lines.push(trimmed);
    } else {
      flush();
      current = { type: "paragraph", lines: [trimmed] };
    }
  }

  flush();
  return blocks;
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
