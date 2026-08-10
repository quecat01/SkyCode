/**
 * Filesystem path resolution and file-operation helpers for Sky Code.
 *
 * Provides the concrete UTF-8 read, write, and targeted-edit operations used
 * by toolhandlers.ts, together with plan-mode descriptions that explain those
 * operations without modifying the filesystem.
 *
 * Paths may be absolute, relative to the active working directory, or use `~`
 * and `~/` to refer to the current user's home directory.
 */

import {
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  resolve,
} from "node:path";

/**
 * Validates that model- or user-supplied file path text is safe to pass to
 * Node's path and filesystem APIs.
 *
 * Empty/whitespace-only paths are rejected. Embedded null characters are also
 * rejected because operating-system path APIs cannot represent them as part of
 * a valid filesystem path.
 *
 * The original string is returned unchanged so significant path characters or
 * whitespace are not silently rewritten.
 *
 * @param {string} inputPath - Raw path supplied to a file operation.
 * @returns {string} The original validated path string.
 * @throws {Error} If the path is empty or contains a null character.
 */
function requireUsablePath(inputPath: string): string {
  if (inputPath.trim() === "") {
    throw new Error("File path must not be empty");
  }

  if (inputPath.includes("\0")) {
    throw new Error("File path contains an invalid null character");
  }

  return inputPath;
}

/**
 * Converts a Sky Code file path into the absolute filesystem path that should
 * be used for the operation.
 *
 * `~` resolves to the current user's home directory and `~/...` resolves
 * beneath it. Already-absolute paths are normalized with path.resolve().
 * Remaining relative paths are resolved against workingDirectory.
 *
 * @param {string} inputPath - Path supplied to the file operation.
 * @param {string} workingDirectory - Base directory for relative paths.
 * Defaults to process.cwd().
 * @returns {string} Absolute normalized filesystem path.
 * @throws {Error} If inputPath is empty or contains a null character.
 */
export function resolveFilePath(
  inputPath: string,
  workingDirectory: string = process.cwd(),
): string {
  const usablePath = requireUsablePath(inputPath);

  // Bare `~` refers to the home directory itself rather than a path relative
  // to the current working directory.
  if (usablePath === "~") {
    return homedir();
  }

  // Node's path utilities do not expand shell-style tildes automatically, so
  // Sky Code handles the common `~/...` form explicitly.
  if (usablePath.startsWith("~/")) {
    return join(
      homedir(),
      usablePath.slice(2),
    );
  }

  if (isAbsolute(usablePath)) {
    return resolve(usablePath);
  }

  return resolve(
    workingDirectory,
    usablePath,
  );
}

/**
 * Describes what a read_file operation would do in plan mode.
 *
 * No filesystem read occurs; path resolution is performed only so the message
 * identifies the exact target that would be used outside plan mode.
 *
 * @param {string} inputPath - Requested file path.
 * @param {string} workingDirectory - Base directory for relative paths.
 * Defaults to process.cwd().
 * @returns {string} Human-readable plan-mode description.
 * @throws {Error} If inputPath fails path validation.
 */
export function describeReadFilePlan(
  inputPath: string,
  workingDirectory: string =
    process.cwd(),
): string {
  const resolvedPath =
    resolveFilePath(
      inputPath,
      workingDirectory,
    );

  return `Plan mode: Sky Code would read ${resolvedPath}, but no file was read.`;
}

/**
 * Describes what a write_file operation would do in plan mode.
 *
 * The reported size is measured as UTF-8 bytes rather than JavaScript string
 * characters so it matches the encoding used by writeFileToDisk().
 *
 * @param {string} inputPath - Requested destination path.
 * @param {string} content - Content that would be written.
 * @param {string} workingDirectory - Base directory for relative paths.
 * Defaults to process.cwd().
 * @returns {string} Human-readable plan-mode description including UTF-8 byte
 * count and resolved destination.
 * @throws {Error} If inputPath fails path validation.
 */
export function describeWriteFilePlan(
  inputPath: string,
  content: string,
  workingDirectory: string =
    process.cwd(),
): string {
  const resolvedPath =
    resolveFilePath(
      inputPath,
      workingDirectory,
    );

  return `Plan mode: Sky Code would write ${Buffer.byteLength(content, "utf8")} bytes to ${resolvedPath}, but no file was changed.`;
}

/**
 * Describes what an edit_file operation would do in plan mode.
 *
 * The file is not read and no search/replacement validation is performed here;
 * the function only resolves the target path and explains the intended action.
 *
 * @param {string} inputPath - Requested file path.
 * @param {string} workingDirectory - Base directory for relative paths.
 * Defaults to process.cwd().
 * @returns {string} Human-readable plan-mode description.
 * @throws {Error} If inputPath fails path validation.
 */
export function describeEditFilePlan(
  inputPath: string,
  workingDirectory: string =
    process.cwd(),
): string {
  const resolvedPath =
    resolveFilePath(
      inputPath,
      workingDirectory,
    );

  return `Plan mode: Sky Code would edit ${resolvedPath} by replacing the requested text, but no file was changed.`;
}

/**
 * Reads a text file from disk as UTF-8.
 *
 * Relative and home-directory paths are normalized through resolveFilePath()
 * before the filesystem is accessed. Native read errors are wrapped with the
 * resolved path so callers receive useful operation context.
 *
 * @param {string} inputPath - File path to read.
 * @param {string} workingDirectory - Base directory for relative paths.
 * Defaults to process.cwd().
 * @returns {Promise<string>} Complete UTF-8 file contents.
 * @throws {Error} If the path is invalid or the file cannot be read.
 *
 * Side effect: reads the resolved file from the local filesystem.
 */
export async function readFileFromDisk(
  inputPath: string,
  workingDirectory: string = process.cwd(),
): Promise<string> {
  const resolvedPath = resolveFilePath(
    inputPath,
    workingDirectory,
  );

  try {
    return await readFile(
      resolvedPath,
      "utf8",
    );
  } catch (error) {
    throw new Error(
      `Unable to read file ${resolvedPath}: ${
        error instanceof Error
          ? error.message
          : String(error)
      }`,
    );
  }
}

/**
 * Writes complete UTF-8 content to a resolved filesystem path.
 *
 * Missing parent directories are created recursively before the file is
 * written. Existing files are replaced according to Node's normal writeFile()
 * behavior.
 *
 * @param {string} inputPath - Destination file path.
 * @param {string} content - Complete UTF-8 text to write.
 * @param {string} workingDirectory - Base directory for relative paths.
 * Defaults to process.cwd().
 * @returns {Promise<string>} Success message containing the UTF-8 byte count
 * and resolved destination path.
 * @throws {Error} If path validation, directory creation, or file writing
 * fails.
 *
 * Side effects: may create parent directories and create or overwrite a file.
 */
export async function writeFileToDisk(
  inputPath: string,
  content: string,
  workingDirectory: string = process.cwd(),
): Promise<string> {
  const resolvedPath = resolveFilePath(
    inputPath,
    workingDirectory,
  );

  try {
    // Recursive creation allows callers to write a new nested path without
    // separately creating every missing parent directory.
    await mkdir(
      dirname(resolvedPath),
      {
        recursive: true,
      },
    );

    await writeFile(
      resolvedPath,
      content,
      "utf8",
    );

    return `Wrote ${Buffer.byteLength(content, "utf8")} bytes to ${resolvedPath}`;
  } catch (error) {
    throw new Error(
      `Unable to write file ${resolvedPath}: ${
        error instanceof Error
          ? error.message
          : String(error)
      }`,
    );
  }
}

/**
 * Counts non-overlapping occurrences of one string within another.
 *
 * The search position advances by the full matched-string length after each
 * occurrence. editFileOnDisk() uses this count to require an unambiguous,
 * exactly-once replacement target.
 *
 * @param {string} content - Text to search.
 * @param {string} searchText - Non-empty text whose occurrences are counted.
 * @returns {number} Number of non-overlapping matches.
 */
function countOccurrences(
  content: string,
  searchText: string,
): number {
  let count = 0;
  let position = 0;

  while (true) {
    const matchIndex = content.indexOf(
      searchText,
      position,
    );

    if (matchIndex === -1) {
      return count;
    }

    count += 1;
    position =
      matchIndex + searchText.length;
  }
}

/**
 * Performs one unambiguous literal text replacement in an existing UTF-8 file.
 *
 * oldText must be non-empty and must appear exactly once in the existing file.
 * Zero matches are rejected because there is nothing to edit; multiple matches
 * are rejected because replacing the first one would make the model's intent
 * ambiguous. After those checks, String.replace() performs the single literal
 * replacement and the complete updated file is written back to disk.
 *
 * @param {string} inputPath - File path to edit.
 * @param {string} oldText - Existing literal text that must occur exactly once.
 * @param {string} newText - Replacement text; may be empty to delete oldText.
 * @param {string} workingDirectory - Base directory for relative paths.
 * Defaults to process.cwd().
 * @returns {Promise<string>} Success message identifying the edited file.
 * @throws {Error} If oldText is empty, the file cannot be read, oldText is not
 * found, oldText occurs more than once, or the modified file cannot be saved.
 *
 * Side effects: reads the existing file and, after validation, overwrites it
 * with the updated UTF-8 content.
 */
export async function editFileOnDisk(
  inputPath: string,
  oldText: string,
  newText: string,
  workingDirectory: string = process.cwd(),
): Promise<string> {
  // Empty search text would match at every string position and cannot identify
  // one meaningful edit target.
  if (oldText === "") {
    throw new Error(
      "old_str must not be empty",
    );
  }

  const resolvedPath = resolveFilePath(
    inputPath,
    workingDirectory,
  );

  let existingContent: string;

  try {
    existingContent = await readFile(
      resolvedPath,
      "utf8",
    );
  } catch (error) {
    throw new Error(
      `Unable to read file ${resolvedPath} before editing: ${
        error instanceof Error
          ? error.message
          : String(error)
      }`,
    );
  }

  // Validate uniqueness before calling replace(), because String.replace()
  // alone would silently modify only the first occurrence.
  const occurrences = countOccurrences(
    existingContent,
    oldText,
  );

  if (occurrences === 0) {
    throw new Error(
      `The requested old_str was not found in ${resolvedPath}`,
    );
  }

  if (occurrences > 1) {
    throw new Error(
      `The requested old_str appears ${occurrences} times in ${resolvedPath}. Provide a more specific string.`,
    );
  }

  const updatedContent =
    existingContent.replace(
      oldText,
      newText,
    );

  try {
    await writeFile(
      resolvedPath,
      updatedContent,
      "utf8",
    );

    return `Edited ${resolvedPath}`;
  } catch (error) {
    throw new Error(
      `Unable to save edited file ${resolvedPath}: ${
        error instanceof Error
          ? error.message
          : String(error)
      }`,
    );
  }
}
