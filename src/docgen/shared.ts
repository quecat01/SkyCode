/**
 * Shared file-generation utility for Sky Code's built-in document tools.
 *
 * create_docx, create_xlsx, create_pdf, and create_pptx each build a finished
 * document as an in-memory Buffer and then call createDocumentFile() to place
 * it on disk safely. Centralizing the write here means every format gets the
 * same guarantees: the destination is never silently overwritten, a crash or
 * failure mid-write never leaves a corrupted file at the real path, and a file
 * that fails its own structural validation is removed rather than left behind
 * looking like a successful result.
 *
 * Path resolution is reused from fileops.ts so document tools honor the same
 * `~`, `~/`, absolute, and working-directory-relative path rules as
 * read_file/write_file/edit_file.
 */

import {
  randomUUID,
} from "node:crypto";

import {
  access,
  mkdir,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";

import {
  existsSync,
} from "node:fs";

import {
  dirname,
} from "node:path";

import {
  resolveFilePath,
} from "../fileops.js";

/**
 * Thrown when a document tool's destination path already has a file at it.
 *
 * Sky Code never overwrites an existing document produced by these tools (see
 * the standing "no silent overwrites" rule): the model must choose a
 * different filename rather than pass an overwrite flag, in every permission
 * mode, so this failure is unconditional rather than something a caller can
 * opt out of.
 */
export class DestinationExistsError extends Error {
  constructor(
    public readonly resolvedPath: string,
  ) {
    super(
      `${resolvedPath} already exists. Choose a different output path; Sky Code's document tools never overwrite an existing file.`,
    );
    this.name = "DestinationExistsError";
  }
}

/**
 * Resolves a document tool's requested output path and confirms nothing is
 * already there.
 *
 * Performed before any document content is generated so an existing-file
 * failure is reported without doing the (potentially expensive) work of
 * building the document first.
 *
 * @param {string} inputPath - Path supplied by the model.
 * @param {string} workingDirectory - Base directory for relative paths.
 * @returns {Promise<string>} Absolute resolved destination path.
 * @throws {DestinationExistsError} If a file already exists at the resolved
 * path.
 * @throws {Error} If the path fails fileops.ts's own path validation.
 */
export async function resolveNewDocumentPath(
  inputPath: string,
  workingDirectory: string,
): Promise<string> {
  const resolvedPath = resolveFilePath(
    inputPath,
    workingDirectory,
  );

  try {
    // access() resolving successfully means a file (or directory) is already
    // there; ENOENT is the only outcome that means it is safe to proceed.
    await access(resolvedPath);

    throw new DestinationExistsError(
      resolvedPath,
    );
  } catch (error) {
    if (error instanceof DestinationExistsError) {
      throw error;
    }

    // Any other access() failure (most commonly ENOENT) means the path is
    // free to write to; permission or other filesystem errors surface later,
    // from the real write attempt, with full context.
  }

  return resolvedPath;
}

/**
 * Writes a finished document buffer to disk without ever leaving a partial or
 * corrupted file at the real destination.
 *
 * The buffer is written to a temporary sibling file in the same directory and
 * then moved into place with fs.rename(), which is atomic on the same
 * filesystem. A crash, an out-of-space error, or any other failure during the
 * write can only ever leave behind an orphaned temp file, never a truncated
 * file at the path the model and user actually asked for.
 *
 * @param {string} resolvedPath - Absolute destination path, already confirmed
 * not to exist by resolveNewDocumentPath().
 * @param {Buffer} content - Complete finished document bytes.
 * @returns {Promise<void>} Resolves once the file is in place.
 * @throws {Error} If the parent directory cannot be created or the write or
 * rename fails.
 *
 * Side effects: creates missing parent directories and creates a new file at
 * resolvedPath.
 */
async function writeBufferAtomically(
  resolvedPath: string,
  content: Buffer,
): Promise<void> {
  const parentDirectory = dirname(
    resolvedPath,
  );

  // Same recursive-creation convenience as writeFileToDisk() in fileops.ts,
  // so a document can be requested into a not-yet-created subdirectory.
  await mkdir(
    parentDirectory,
    {
      recursive: true,
    },
  );

  // The temp file lives beside the real destination (not in a system temp
  // directory) so the final rename() stays on one filesystem and is atomic.
  const temporaryPath = `${resolvedPath}.sky-tmp-${randomUUID()}`;

  try {
    await writeFile(
      temporaryPath,
      content,
    );

    await rename(
      temporaryPath,
      resolvedPath,
    );
  } catch (error) {
    // Best-effort cleanup: an unlink failure here (for example because the
    // write never actually created the temp file) must not mask the real
    // error from the write or rename above.
    await unlink(temporaryPath).catch(
      () => {},
    );

    throw error;
  }
}

/**
 * Confirms a just-written document file exists and is non-empty.
 *
 * File existence alone is not sufficient evidence of success (a zero-byte
 * file is not a usable document), so this checks both.
 *
 * @param {string} resolvedPath - Path expected to contain the finished
 * document.
 * @returns {Promise<number>} File size in bytes.
 * @throws {Error} If the file is missing or empty.
 */
async function verifyWrittenFile(
  resolvedPath: string,
): Promise<number> {
  const stats = await stat(
    resolvedPath,
  );

  if (stats.size === 0) {
    throw new Error(
      `${resolvedPath} was written but is empty.`,
    );
  }

  return stats.size;
}

/**
 * Options accepted by createDocumentFile().
 */
export interface CreateDocumentFileOptions {
  /** Path supplied by the model for the finished document. */
  inputPath: string;
  /** Base directory used to resolve a relative inputPath. */
  workingDirectory: string;
  /**
   * Builds the complete document as an in-memory buffer. Called only after
   * the destination has been confirmed free, so a build failure never leaves
   * anything on disk.
   */
  build: () => Promise<Buffer>;
  /**
   * Optional format-specific structural check run against the file after it
   * has been written (for example, confirming a required internal part
   * exists inside a DOCX/XLSX/PPTX zip package, or that a PDF has the
   * expected header and trailer). Receives the resolved path so it can
   * re-read the file from disk. Throwing rejects the result; the file is then
   * removed rather than left behind looking like a successful document.
   */
  validate?: (
    resolvedPath: string,
  ) => Promise<void>;
}

/**
 * Result returned by createDocumentFile() on success.
 */
export interface CreateDocumentFileResult {
  /** Absolute path of the written document. */
  resolvedPath: string;
  /** Size of the written document in bytes. */
  sizeBytes: number;
}

/**
 * Shared orchestration used by every Sky Code document-generation tool:
 * resolve the destination, refuse if something is already there, build the
 * document, write it atomically, verify it landed correctly, and optionally
 * run a format-specific structural check.
 *
 * A validation failure removes the just-written file before rethrowing, so a
 * failed generation never leaves a file behind that looks like a successful
 * one.
 *
 * @param {CreateDocumentFileOptions} options - Path, build function, and
 * optional post-write validation for one document.
 * @returns {Promise<CreateDocumentFileResult>} Resolved path and size of the
 * finished document.
 * @throws {DestinationExistsError} If the destination already exists.
 * @throws {Error} If building, writing, verifying, or validating the document
 * fails.
 *
 * Side effects: may create parent directories and create a new file; on a
 * validation failure, deletes the file it just wrote.
 */
export async function createDocumentFile(
  options: CreateDocumentFileOptions,
): Promise<CreateDocumentFileResult> {
  const resolvedPath = await resolveNewDocumentPath(
    options.inputPath,
    options.workingDirectory,
  );

  const content = await options.build();

  await writeBufferAtomically(
    resolvedPath,
    content,
  );

  const sizeBytes = await verifyWrittenFile(
    resolvedPath,
  );

  if (options.validate) {
    try {
      await options.validate(
        resolvedPath,
      );
    } catch (error) {
      // A file that fails structural validation is not a usable document;
      // removing it keeps a failed generation from looking like a success on
      // a later read_file or directory listing.
      await unlink(resolvedPath).catch(
        () => {},
      );

      throw error;
    }
  }

  return {
    resolvedPath,
    sizeBytes,
  };
}

/**
 * Formats a human-readable byte size for tool result messages.
 *
 * Kept intentionally simple (bytes or one decimal of KB) to match the plain,
 * terse style used elsewhere in Sky Code's tool output.
 *
 * @param {number} sizeBytes - File size in bytes.
 * @returns {string} Human-readable size, e.g. "842 bytes" or "14.2 KB".
 */
export function formatFileSize(
  sizeBytes: number,
): string {
  if (sizeBytes < 1024) {
    return `${sizeBytes} bytes`;
  }

  return `${(sizeBytes / 1024).toFixed(1)} KB`;
}

/**
 * Describes what a document-creation tool would do in plan mode.
 *
 * Synchronous, and deliberately does not use resolveNewDocumentPath()'s
 * (async, throwing) existence check: every describe*Plan helper in Sky Code,
 * including this one, is called from permissions.ts's synchronous
 * describePlanModeToolRequest(), so a plan-mode description must always
 * succeed and must not return a Promise. An existing destination is reported
 * as a note within the description text instead.
 *
 * @param {string} inputPath - Requested destination path.
 * @param {string} workingDirectory - Base directory for relative paths.
 * @param {string} formatLabel - Human-readable format name, e.g. "DOCX".
 * @returns {string} Human-readable plan-mode description.
 * @throws {Error} If inputPath fails path validation.
 */
export function describeCreateDocumentPlan(
  inputPath: string,
  workingDirectory: string,
  formatLabel: string,
): string {
  const resolvedPath = resolveFilePath(
    inputPath,
    workingDirectory,
  );

  const conflictNote = existsSync(
    resolvedPath,
  )
    ? ` A file already exists at that path, so this would fail outside plan mode; Sky Code's document tools never overwrite an existing file.`
    : "";

  return `Plan mode: Sky Code would create a ${formatLabel} file at ${resolvedPath}, but no file was written.${conflictNote}`;
}
