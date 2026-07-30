import {
  readFile,
} from "node:fs/promises";

import type {
  SessionRole,
} from "./session.js";

export interface HistorySearchCommand {
  action:
    "search";

  term:
    string;
}

export interface HistoryMatch {
  timestamp:
    string;

  role:
    SessionRole;

  content:
    string;

  lineNumber:
    number;
}

function isRecord(
  value:
    unknown,
): value is Record<
  string,
  unknown
> {
  return (
    typeof value ===
      "object" &&
    value !==
      null &&
    !Array.isArray(
      value,
    )
  );
}

function isSessionRole(
  value:
    unknown,
): value is SessionRole {
  return (
    value ===
      "user" ||
    value ===
      "assistant" ||
    value ===
      "system" ||
    value ===
      "tool"
  );
}

export function parseHistoryCommand(
  userInput:
    string,
): HistorySearchCommand | null {
  const trimmedInput =
    userInput.trim();

  if (
    trimmedInput ===
      "/history"
  ) {
    throw new Error(
      "Usage: /history search <term>",
    );
  }

  if (
    !trimmedInput.startsWith(
      "/history ",
    )
  ) {
    return null;
  }

  const remainder =
    trimmedInput
      .slice(
        "/history ".length,
      )
      .trim();

  const firstSpace =
    remainder.indexOf(
      " ",
    );

  const action =
    (
      firstSpace ===
        -1
        ? remainder
        : remainder.slice(
            0,
            firstSpace,
          )
    ).trim();

  const argument =
    firstSpace ===
      -1
      ? ""
      : remainder
          .slice(
            firstSpace +
              1,
          )
          .trim();

  if (
    action !==
      "search"
  ) {
    throw new Error(
      `Unknown history action "${action}". Usage: /history search <term>`,
    );
  }

  if (
    argument ===
      ""
  ) {
    throw new Error(
      "Missing history search term. Usage: /history search <term>",
    );
  }

  return {
    action:
      "search",

    term:
      argument,
  };
}

export async function searchSessionHistory(
  filePath:
    string,

  term:
    string,
): Promise<HistoryMatch[]> {
  const normalizedTerm =
    term
      .trim()
      .toLowerCase();

  if (
    normalizedTerm ===
      ""
  ) {
    throw new Error(
      "History search term must not be empty.",
    );
  }

  let contents:
    string;

  try {
    contents =
      await readFile(
        filePath,
        "utf8",
      );
  } catch (error) {
    throw new Error(
      `Unable to read session history ${filePath}: ${
        error instanceof
          Error
          ? error.message
          : String(
              error,
            )
      }`,
    );
  }

  const lines =
    contents.split(
      /\r?\n/,
    );

  const matches:
    HistoryMatch[] = [];

  for (
    let index = 0;
    index <
      lines.length;
    index +=
      1
  ) {
    const line =
      lines[index];

    if (
      line ===
        undefined ||
      line.trim() ===
        ""
    ) {
      continue;
    }

    let parsed:
      unknown;

    try {
      parsed =
        JSON.parse(
          line,
        );
    } catch (error) {
      throw new Error(
        `Unable to parse session history line ${index + 1} in ${filePath}: ${
          error instanceof
            Error
            ? error.message
            : String(
                error,
              )
        }`,
      );
    }

    if (
      !isRecord(
        parsed,
      ) ||
      parsed.type !==
        "message" ||
      typeof parsed.timestamp !==
        "string" ||
      !isSessionRole(
        parsed.role,
      ) ||
      typeof parsed.content !==
        "string"
    ) {
      continue;
    }

    if (
      !parsed.content
        .toLowerCase()
        .includes(
          normalizedTerm,
        )
    ) {
      continue;
    }

    matches.push({
      timestamp:
        parsed.timestamp,

      role:
        parsed.role,

      content:
        parsed.content,

      lineNumber:
        index +
        1,
    });
  }

  return matches;
}

export function formatHistorySearchResults(
  term:
    string,

  matches:
    readonly HistoryMatch[],
): string {
  if (
    matches.length ===
      0
  ) {
    return `No matching conversation turns found for "${term}".`;
  }

  const lines = [
    `History matches for "${term}":`,
  ];

  for (
    const match of
    matches
  ) {
    const contentLines =
      match.content.split(
        /\r?\n/,
      );

    const firstLine =
      contentLines[0] ??
      "";

    lines.push(
      `[${match.timestamp}] ${match.role}: ${firstLine}`,
    );

    for (
      const continuation of
      contentLines.slice(
        1,
      )
    ) {
      lines.push(
        `  ${continuation}`,
      );
    }
  }

  return lines.join(
    "\n",
  );
}
