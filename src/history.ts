/**
 * Session-history command parsing, searching, and display formatting for Sky
 * Code.
 *
 * Parses the `/history search <term>` CLI command, searches persisted JSONL
 * session logs for matching conversation-message content, and formats matching
 * turns for terminal display.
 *
 * History searching is case-insensitive but otherwise performs literal
 * substring matching against stored message content.
 */
import {
  readFile,
} from "node:fs/promises";

import type {
  SessionRole,
} from "./session.js";

/**
 * Parsed `/history search` command.
 *
 * The action is currently fixed to `search`; term contains the non-empty text
 * that should be looked up in the active session history.
 */
export interface HistorySearchCommand {
  action:
    "search";

  term:
    string;
}

/**
 * One matching conversation-message record found in persisted session history.
 *
 * lineNumber is the one-based JSONL source line, preserving a direct reference
 * back to the stored log entry.
 */
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

/**
 * Checks whether an unknown value is a non-null, non-array object.
 *
 * Used as the first structural guard before accessing properties of parsed
 * JSONL values.
 *
 * @param {unknown} value - Value to inspect.
 * @returns {boolean} True when value can be treated as an object record.
 */
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

/**
 * Checks whether an unknown value is one of the persisted SessionRole values.
 *
 * @param {unknown} value - Candidate role value.
 * @returns {boolean} True for user, assistant, system, or tool.
 */
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

/**
 * Parses user input when it represents a Sky Code history command.
 *
 * Input that does not begin with `/history ` returns null so the caller can
 * continue treating it as ordinary conversation input. A bare `/history`,
 * unsupported history action, or missing search term is recognized as an
 * attempted history command and produces a usage error instead.
 *
 * The search term may contain spaces; everything following the `search`
 * action is retained as one trimmed term.
 *
 * @param {string} userInput - Raw interactive input.
 * @returns {HistorySearchCommand | null} Parsed search command, or null when
 * the input is not a history command.
 * @throws {Error} For a bare history command, unsupported action, or missing
 * search term.
 */
export function parseHistoryCommand(
  userInput:
    string,
): HistorySearchCommand | null {
  const trimmedInput =
    userInput.trim();

  // A bare command is recognized as incomplete history syntax so the user
  // receives usage guidance instead of sending it to the model.
  if (
    trimmedInput ===
      "/history"
  ) {
    throw new Error(
      "Usage: /history search <term>",
    );
  }

  // Inputs outside the history-command namespace pass back to the normal
  // conversation flow unchanged.
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

  // Split only at the first space so multi-word search terms remain intact.
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

/**
 * Searches a persisted session JSONL file for conversation messages containing
 * a term.
 *
 * The search term and stored message content are compared case-insensitively
 * using literal substring matching. Blank JSONL lines are ignored. Valid JSON
 * records that are not usable message events are skipped rather than treated
 * as matches.
 *
 * Malformed JSON throws with the source file and one-based line number because
 * it indicates a damaged session log rather than merely an irrelevant record.
 *
 * @param {string} filePath - Session JSONL file to search.
 * @param {string} term - Non-empty text to locate in message content.
 * @returns {Promise<HistoryMatch[]>} Matching message records in source order.
 * @throws {Error} If term is empty, the file cannot be read, or a non-empty
 * JSONL line cannot be parsed.
 *
 * Side effect: reads the specified session-history file from disk.
 */
export async function searchSessionHistory(
  filePath:
    string,

  term:
    string,
): Promise<HistoryMatch[]> {
  // Normalize the search term once; message contents are lowercased during
  // comparison to provide case-insensitive literal matching.
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

  // Wrap filesystem errors with the session-history path so the CLI can show
  // which persisted log could not be searched.
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

    // Blank JSONL lines are ignored without changing their physical position,
    // preserving accurate one-based line numbers for later records.
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

    // JSONL stores one independent JSON object per non-empty physical line.
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

    // Ignore lifecycle, compaction, background, and malformed message-shaped
    // records; history search is specifically over usable conversation content.
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

    // Search terms are literal substrings; no regular-expression or token
    // interpretation is applied.
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

/**
 * Formats history-search matches for human-readable terminal output.
 *
 * With no matches, a single explanatory sentence is returned. Otherwise each
 * match begins with timestamp, role, and the first content line. Additional
 * lines from the same message are indented so multi-line turns stay visually
 * grouped.
 *
 * @param {string} term - Search term displayed in the heading.
 * @param {readonly HistoryMatch[]} matches - Matches to render in supplied
 * order.
 * @returns {string} Complete terminal-ready history-search output.
 */
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
    // Preserve multi-line message structure while applying the timestamp and
    // role prefix only to the first line.
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
