/**
 * Generic file ingestion pipeline for knowledge bases.
 *
 * Handles:
 * - Plain text files (.txt, .md, .csv, .tsv, .json, .yaml, .yml, .xml, .html, .htm, .log, .rst, .tex, .py, .js, .ts, etc.)
 * - PDF files (.pdf)
 * - Archives (.zip, .tar, .tar.gz, .tgz) — auto-extracted and walked recursively
 * - Skips binary/unrecognized files with a warning
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative } from "node:path";
import AdmZip from "adm-zip";
import { v4 as uuidv4 } from "uuid";
import { createLogger } from "../../shared/logger.js";
import type { Chunk, ChunkOptions } from "./chunker.js";
import { chunkPdfPages, chunkText } from "./chunker.js";

const log = createLogger("server:kb:ingestion");

// Text-based extensions we know how to handle
const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".csv",
  ".tsv",
  ".json",
  ".jsonl",
  ".ndjson",
  ".yaml",
  ".yml",
  ".xml",
  ".html",
  ".htm",
  ".rst",
  ".tex",
  ".log",
  ".py",
  ".js",
  ".ts",
  ".tsx",
  ".jsx",
  ".java",
  ".go",
  ".rs",
  ".rb",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".cs",
  ".swift",
  ".kt",
  ".scala",
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".ps1",
  ".sql",
  ".graphql",
  ".gql",
  ".toml",
  ".ini",
  ".cfg",
  ".conf",
  ".properties",
  ".env",
  ".gitignore",
  ".dockerignore",
  ".editorconfig",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".svg",
  ".mermaid",
  ".r",
  ".R",
  ".rmd",
]);

const ARCHIVE_EXTENSIONS = new Set([".zip", ".tar", ".tgz"]);

export interface IngestedFile {
  name: string;
  filePath: string;
  sizeBytes: number;
  chunks: Chunk[];
}

export interface IngestionResult {
  files: IngestedFile[];
  skipped: string[];
  errors: Array<{ file: string; error: string }>;
}

/**
 * Check if a file extension indicates a text-based file.
 */
function isTextFile(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  return TEXT_EXTENSIONS.has(ext);
}

/**
 * Check if a file is a PDF.
 */
function isPdf(filePath: string): boolean {
  return extname(filePath).toLowerCase() === ".pdf";
}

/**
 * Check if a file is an archive.
 */
function isArchive(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) return true;
  const ext = extname(lower);
  return ARCHIVE_EXTENSIONS.has(ext);
}

/**
 * Extract a zip archive to a temporary directory.
 */
function extractZip(archivePath: string, destDir: string): void {
  const zip = new AdmZip(archivePath);
  zip.extractAllTo(destDir, true);
}

/**
 * Extract a tar/tar.gz/tgz archive to a temporary directory.
 */
function extractTar(archivePath: string, destDir: string): void {
  mkdirSync(destDir, { recursive: true });
  execFileSync("tar", ["xf", archivePath, "-C", destDir]);
}

/**
 * Extract an archive to a temp directory and return the path.
 */
function extractArchive(archivePath: string): string {
  const destDir = join(tmpdir(), `sos-kb-extract-${uuidv4()}`);
  mkdirSync(destDir, { recursive: true });

  const lower = archivePath.toLowerCase();
  if (lower.endsWith(".zip")) {
    extractZip(archivePath, destDir);
  } else if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz") || lower.endsWith(".tar")) {
    extractTar(archivePath, destDir);
  } else {
    throw new Error(`Unsupported archive format: ${extname(archivePath)}`);
  }

  return destDir;
}

/**
 * Recursively walk a directory and return all file paths.
 */
function walkDir(dir: string): string[] {
  const files: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    // Skip hidden files/dirs and common non-content dirs
    if (
      entry.name.startsWith(".") ||
      entry.name === "node_modules" ||
      entry.name === "__pycache__"
    ) {
      continue;
    }

    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkDir(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
}

/**
 * Extract text from a PDF file.
 * Returns an array of { pageNum, text } for page-aware chunking.
 */
async function extractPdfText(filePath: string): Promise<Array<{ pageNum: number; text: string }>> {
  const pdfModule = await import("pdf-parse");
  const pdfParse = (pdfModule as any).default || pdfModule;
  const buffer = readFileSync(filePath);

  // pdf-parse doesn't give per-page text easily, so we get the full text
  // and treat it as a single "page" with page=1
  const data = await pdfParse(buffer);
  return [{ pageNum: 1, text: data.text }];
}

/**
 * Stamp file_path and parent_dir metadata onto every chunk produced for a file.
 */
function stampPathMetadata(chunks: Chunk[], filePath: string): void {
  const parentDir = dirname(filePath);
  for (const chunk of chunks) {
    chunk.metadata.file_path = filePath;
    chunk.metadata.parent_dir = parentDir === "." ? "" : parentDir;
  }
}

/**
 * Process a single file: read, chunk, and return results.
 *
 * @param diskPath - Absolute path to the file on disk (temp location)
 * @param relativeName - Display name / document name stored in MongoDB
 * @param hierarchyPath - Path relative to the upload root (for hierarchy metadata)
 * @param options - Chunking configuration
 */
async function processFile(
  diskPath: string,
  relativeName: string,
  hierarchyPath: string,
  options: ChunkOptions,
): Promise<IngestedFile | null> {
  const stat = statSync(diskPath);

  if (isPdf(diskPath)) {
    try {
      const pages = await extractPdfText(diskPath);
      const chunks = chunkPdfPages(pages, options, relativeName);
      stampPathMetadata(chunks, hierarchyPath);
      return { name: relativeName, filePath: hierarchyPath, sizeBytes: stat.size, chunks };
    } catch (err: any) {
      throw new Error(`PDF extraction failed: ${err.message}`);
    }
  }

  if (isTextFile(diskPath)) {
    try {
      const text = readFileSync(diskPath, "utf-8");
      // Skip empty files
      if (!text.trim()) return null;
      const chunks = chunkText(text, options, relativeName);
      stampPathMetadata(chunks, hierarchyPath);
      return { name: relativeName, filePath: hierarchyPath, sizeBytes: stat.size, chunks };
    } catch (err: any) {
      throw new Error(`Text read failed: ${err.message}`);
    }
  }

  // Try to read as UTF-8 anyway — if it works and has content, chunk it
  try {
    const text = readFileSync(diskPath, "utf-8");
    // Check for binary content (null bytes)
    if (text.includes("\0")) return null;
    if (!text.trim()) return null;
    const chunks = chunkText(text, options, relativeName);
    stampPathMetadata(chunks, hierarchyPath);
    return { name: relativeName, filePath: hierarchyPath, sizeBytes: stat.size, chunks };
  } catch {
    return null;
  }
}

/**
 * Ingest files from a buffer (uploaded via API).
 *
 * @param files - Array of { filename, buffer } pairs
 * @param options - Chunking configuration
 * @returns Ingestion results with processed files, skipped files, and errors
 */
export async function ingestFiles(
  files: Array<{ filename: string; buffer: Buffer }>,
  options: ChunkOptions,
): Promise<IngestionResult> {
  const result: IngestionResult = { files: [], skipped: [], errors: [] };
  const tempDirs: string[] = [];

  try {
    for (const { filename, buffer } of files) {
      if (isArchive(filename)) {
        // Write to temp file, extract, and process all contained files
        const tempFile = join(tmpdir(), `sos-kb-${uuidv4()}-${filename}`);
        writeFileSync(tempFile, buffer);

        try {
          const extractDir = extractArchive(tempFile);
          tempDirs.push(extractDir);

          const extractedFiles = walkDir(extractDir);
          for (const extractedPath of extractedFiles) {
            const hierarchyPath = relative(extractDir, extractedPath);
            const relName = `${filename}/${hierarchyPath}`;
            try {
              const ingested = await processFile(extractedPath, relName, hierarchyPath, options);
              if (ingested) {
                result.files.push(ingested);
              } else {
                result.skipped.push(relName);
              }
            } catch (err: any) {
              result.errors.push({ file: relName, error: err.message });
            }
          }
        } catch (err: any) {
          result.errors.push({
            file: filename,
            error: `Archive extraction failed: ${err.message}`,
          });
        } finally {
          // Clean up temp file
          try {
            rmSync(tempFile, { force: true });
          } catch {}
        }
      } else {
        // Single file: write to temp, process, clean up
        const tempFile = join(tmpdir(), `sos-kb-${uuidv4()}-${filename}`);
        writeFileSync(tempFile, buffer);

        try {
          const ingested = await processFile(tempFile, filename, filename, options);
          if (ingested) {
            result.files.push(ingested);
          } else {
            result.skipped.push(filename);
          }
        } catch (err: any) {
          result.errors.push({ file: filename, error: err.message });
        } finally {
          try {
            rmSync(tempFile, { force: true });
          } catch {}
        }
      }
    }
  } finally {
    // Clean up extracted directories
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  }

  log.info("Ingestion complete", {
    processed: result.files.length,
    skipped: result.skipped.length,
    errors: result.errors.length,
    totalChunks: result.files.reduce((sum, f) => sum + f.chunks.length, 0),
  });

  return result;
}
