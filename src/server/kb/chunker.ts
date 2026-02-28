/**
 * Markdown-aware text chunking for knowledge base ingestion.
 *
 * Strategy:
 * 1. Split on markdown headings (##, ###, etc.) to preserve section boundaries
 * 2. Within sections, split on paragraph boundaries (double newlines)
 * 3. If a paragraph exceeds chunk_size, split on sentence boundaries
 * 4. If a sentence exceeds chunk_size, split on token windows with overlap
 *
 * Token estimation: ~4 chars per token (conservative for English text).
 */

import { createLogger } from "../../shared/logger.js";

const log = createLogger("server:kb:chunker");

const CHARS_PER_TOKEN = 4;

export interface ChunkOptions {
  chunkSize: number; // target chunk size in tokens
  chunkOverlap: number; // overlap between consecutive chunks in tokens
}

export interface Chunk {
  content: string;
  metadata: {
    section?: string;
    page?: number;
  };
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function trimChunk(text: string): string {
  return text.trim().replace(/\n{3,}/g, "\n\n");
}

/**
 * Split text into sections based on markdown headings.
 * Returns an array of { heading, content } objects.
 */
function splitByHeadings(text: string): Array<{ heading: string | undefined; content: string }> {
  const headingRegex = /^(#{1,6})\s+(.+)$/gm;
  const sections: Array<{ heading: string | undefined; content: string }> = [];

  let lastIndex = 0;
  let lastHeading: string | undefined;
  let match: RegExpExecArray | null;

  match = headingRegex.exec(text);
  while (match !== null) {
    const beforeContent = text.slice(lastIndex, match.index);
    if (beforeContent.trim()) {
      sections.push({ heading: lastHeading, content: beforeContent.trim() });
    }
    lastHeading = match[2].trim();
    lastIndex = match.index + match[0].length;
    match = headingRegex.exec(text);
  }

  // Remaining content after last heading
  const remaining = text.slice(lastIndex);
  if (remaining.trim()) {
    sections.push({ heading: lastHeading, content: remaining.trim() });
  }

  // If no headings found, return the whole text as one section
  if (sections.length === 0 && text.trim()) {
    sections.push({ heading: undefined, content: text.trim() });
  }

  return sections;
}

/**
 * Split text on paragraph boundaries (double newlines).
 */
function splitByParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * Split text on sentence boundaries.
 */
function splitBySentences(text: string): string[] {
  // Split on sentence-ending punctuation followed by space or newline
  const sentences = text.split(/(?<=[.!?])\s+/);
  return sentences.map((s) => s.trim()).filter(Boolean);
}

/**
 * Split text into fixed-size token windows with overlap.
 * This is the fallback for text that can't be split at natural boundaries.
 */
function splitByTokenWindow(text: string, chunkSize: number, chunkOverlap: number): string[] {
  const maxChars = chunkSize * CHARS_PER_TOKEN;
  const overlapChars = chunkOverlap * CHARS_PER_TOKEN;
  const stepChars = maxChars - overlapChars;
  const chunks: string[] = [];

  if (stepChars <= 0) {
    // Edge case: overlap >= chunk size, just return the whole text
    return [text];
  }

  for (let i = 0; i < text.length; i += stepChars) {
    const chunk = text.slice(i, i + maxChars);
    if (chunk.trim()) {
      chunks.push(chunk.trim());
    }
  }

  return chunks;
}

/**
 * Merge small fragments into chunks up to the target size.
 */
function mergeFragments(fragments: string[], chunkSize: number, chunkOverlap: number): string[] {
  const maxChars = chunkSize * CHARS_PER_TOKEN;
  const chunks: string[] = [];
  let current = "";

  for (const fragment of fragments) {
    const combined = current ? `${current}\n\n${fragment}` : fragment;

    if (estimateTokens(combined) <= chunkSize) {
      current = combined;
    } else {
      if (current) {
        chunks.push(trimChunk(current));
      }

      // If this single fragment exceeds the chunk size, split it further
      if (estimateTokens(fragment) > chunkSize) {
        const sentences = splitBySentences(fragment);
        if (sentences.length > 1) {
          const subChunks = mergeFragments(sentences, chunkSize, chunkOverlap);
          chunks.push(...subChunks);
          current = "";
        } else {
          // Single sentence too long — use token window splitting
          const windows = splitByTokenWindow(fragment, chunkSize, chunkOverlap);
          // All but last go directly to chunks
          for (let i = 0; i < windows.length - 1; i++) {
            chunks.push(trimChunk(windows[i]));
          }
          current = windows[windows.length - 1] || "";
        }
      } else {
        current = fragment;
      }
    }
  }

  if (current.trim()) {
    chunks.push(trimChunk(current));
  }

  return chunks;
}

/**
 * Chunk a text document into pieces suitable for embedding.
 *
 * @param text - The full document text
 * @param options - Chunking configuration
 * @param sourceFile - The source file name (for logging)
 * @returns Array of chunks with metadata
 */
export function chunkText(text: string, options: ChunkOptions, sourceFile?: string): Chunk[] {
  const { chunkSize, chunkOverlap } = options;

  if (!text.trim()) return [];

  const sections = splitByHeadings(text);
  const allChunks: Chunk[] = [];

  for (const section of sections) {
    const paragraphs = splitByParagraphs(section.content);
    const merged = mergeFragments(paragraphs, chunkSize, chunkOverlap);

    for (const content of merged) {
      allChunks.push({
        content,
        metadata: {
          section: section.heading,
        },
      });
    }
  }

  log.info("Text chunked", {
    sourceFile,
    sections: sections.length,
    chunks: allChunks.length,
    chunkSize,
    chunkOverlap,
  });

  return allChunks;
}

/**
 * Chunk a PDF document. The text is already extracted; we just need to
 * track page numbers.
 *
 * @param pages - Array of { pageNum, text } from PDF extraction
 * @param options - Chunking configuration
 * @param sourceFile - The source file name
 */
export function chunkPdfPages(
  pages: Array<{ pageNum: number; text: string }>,
  options: ChunkOptions,
  sourceFile?: string,
): Chunk[] {
  // Concatenate all pages with page markers
  const allChunks: Chunk[] = [];

  for (const page of pages) {
    if (!page.text.trim()) continue;

    const paragraphs = splitByParagraphs(page.text);
    const merged = mergeFragments(paragraphs, options.chunkSize, options.chunkOverlap);

    for (const content of merged) {
      allChunks.push({
        content,
        metadata: {
          page: page.pageNum,
        },
      });
    }
  }

  log.info("PDF chunked", {
    sourceFile,
    pages: pages.length,
    chunks: allChunks.length,
  });

  return allChunks;
}
