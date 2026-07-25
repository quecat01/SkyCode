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

function requireUsablePath(inputPath: string): string {
  if (inputPath.trim() === "") {
    throw new Error("File path must not be empty");
  }

  if (inputPath.includes("\0")) {
    throw new Error("File path contains an invalid null character");
  }

  return inputPath;
}

export function resolveFilePath(
  inputPath: string,
  workingDirectory: string = process.cwd(),
): string {
  const usablePath = requireUsablePath(inputPath);

  if (usablePath === "~") {
    return homedir();
  }

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

export async function editFileOnDisk(
  inputPath: string,
  oldText: string,
  newText: string,
  workingDirectory: string = process.cwd(),
): Promise<string> {
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
