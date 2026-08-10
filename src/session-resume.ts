/**
 * Session discovery and conversation reconstruction for Sky Code.
 *
 * Reads persisted JSONL session records, rebuilds the resumable chat history,
 * replays stored compaction decisions, restores eligible tool-result messages,
 * and locates the most recently modified resumable session for a working
 * directory.
 *
 * Discovery is deliberately tolerant of individual malformed session files:
 * candidate files that cannot be loaded are skipped so an older valid session
 * can still be resumed.
 */
import {
  readdir,
  readFile,
  stat,
} from "node:fs/promises";

import {
  homedir,
} from "node:os";

import {
  join,
  resolve,
} from "node:path";

import type {
  ChatMessage,
} from "./chat.js";

import {
  createCompactionSummaryMessage,
} from "./compact.js";

import {
  shouldReturnToPromptAfterBackgroundTool,
} from "./background-turn.js";

import type {
  SessionRecord,
} from "./session.js";

import {
  parseSkyToolRequest,
  type ToolExecutionResult,
} from "./tools.js";

/**
 * Fully reconstructed session state that can be offered for resume.
 *
 * Includes the persistent log identity and timestamps, normalized original
 * working directory, most recently recorded non-empty model identifier when
 * available, source-record count, and reconstructed user/assistant history.
 */
export interface ResumableSession {
  filePath:
    string;

  sessionId:
    string;

  workingDirectory:
    string;

  startedAt:
    string;

  updatedAt:
    string;

  model?:
    string;

  recordCount:
    number;

  messages:
    ChatMessage[];
}

/**
 * Checks whether an unknown value is a non-null, non-array object.
 *
 * This lightweight guard is used both for parsed JSON session records and for
 * inspecting filesystem errors such as ENOENT without assuming their shape.
 *
 * @param {unknown} value - Value to inspect.
 * @returns {boolean} True when value is an object record.
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
 * Performs the minimum structural validation required before treating parsed
 * JSON as a SessionRecord.
 *
 * Only timestamp, sessionId, and type are required here. Event-specific fields
 * remain optional and are validated later by the reconstruction logic that
 * actually consumes them.
 *
 * @param {unknown} value - Parsed JSON value.
 * @param {string} filePath - Session file used for diagnostic errors.
 * @param {number} lineNumber - One-based source line number.
 * @returns {SessionRecord} Structurally valid session record.
 * @throws {Error} If the value is not an object or lacks required string
 * fields.
 */
function parseSessionRecord(
  value:
    unknown,

  filePath:
    string,

  lineNumber:
    number,
): SessionRecord {
  if (
    !isRecord(
      value,
    ) ||
    typeof value.timestamp !==
      "string" ||
    typeof value.sessionId !==
      "string" ||
    typeof value.type !==
      "string"
  ) {
    throw new Error(
      `Invalid session record at line ${lineNumber} in ${filePath}`,
    );
  }

  return value as unknown as
    SessionRecord;
}

/**
 * Reads and parses all non-empty JSONL records from one session file.
 *
 * Blank lines are ignored. Each remaining line must contain valid JSON and
 * pass the minimal SessionRecord structure check. Parse errors include both
 * file path and one-based line number to make damaged logs diagnosable.
 *
 * @param {string} filePath - JSONL session file to read.
 * @returns {Promise<SessionRecord[]>} Records in their original file order.
 * @throws {Error} If the file cannot be read, a JSON line cannot be parsed, or
 * a parsed record fails structural validation.
 *
 * Side effect: reads the specified session file from disk.
 */
export async function readSessionRecords(
  filePath:
    string,
): Promise<SessionRecord[]> {
  const contents =
    await readFile(
      filePath,
      "utf8",
    );

  const records:
    SessionRecord[] = [];

  const lines =
    contents.split(
      /\r?\n/,
    );

  for (
    let index = 0;
    index <
      lines.length;
    index +=
      1
  ) {
    const line =
      lines[index];

    // Empty lines are harmless in JSONL logs and are intentionally skipped.
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
        `Unable to parse session line ${index + 1} in ${filePath}: ${
          error instanceof
            Error
            ? error.message
            : String(
                error,
              )
        }`,
      );
    }

    records.push(
      parseSessionRecord(
        parsed,
        filePath,
        index +
          1,
      ),
    );
  }

  return records;
}

/**
 * Recreates the synthetic chat message that feeds a stored tool result back
 * into the model conversation during session reconstruction.
 *
 * Tool results are represented as a user-role message because that is the same
 * follow-up protocol used by the live Sky Code tool loop.
 *
 * @param {string} tool - Tool name whose result is being restored.
 * @param {ToolExecutionResult} result - Stored success state and output.
 * @returns {ChatMessage} Synthetic continuation message for the reconstructed
 * conversation.
 */
function createRestoredToolResultMessage(
  tool:
    string,

  result:
    ToolExecutionResult,
): ChatMessage {
  return {
    role:
      "user",

    content: [
      `Sky Code tool result for ${tool}:`,
      JSON.stringify(
        {
          success:
            result.success,

          output:
            result.output,
        },
        null,
        2,
      ),
      "",
      "Continue responding to the user.",
      "Use another sky-tool block if another tool is required.",
    ].join(
      "\n",
    ),
  };
}

/**
 * Replays one persisted compaction event against reconstructed chat messages.
 *
 * `sliding-window` keeps only the newest afterMessageCount messages.
 * `summarise` replaces older history with the stored summary message and keeps
 * the required number of recent messages after it. Missing strategy values
 * default to `summarise` for stored records that predate explicit strategies.
 *
 * @param {ChatMessage[]} messages - Mutable conversation reconstructed so far.
 * @param {SessionRecord} record - Stored compaction event to replay.
 * @returns {void}
 * @throws {Error} If afterMessageCount is invalid, the stored strategy is
 * unsupported, or a summarise record lacks a usable summary.
 *
 * Side effect: mutates messages to reproduce the historical compacted state.
 */
function applyCompactionRecord(
  messages:
    ChatMessage[],

  record:
    SessionRecord,
): void {
  const afterMessageCount =
    record.afterMessageCount;

  if (
    !Number.isSafeInteger(
      afterMessageCount,
    ) ||
    afterMessageCount ===
      undefined ||
    afterMessageCount <
      0
  ) {
    throw new Error(
      "Compaction session record has an invalid afterMessageCount.",
    );
  }

  // Older stored records may not contain a strategy field; their historical
  // behavior is interpreted as summarise compaction.
  const strategy =
    record.strategy ??
    "summarise";

  // Sliding-window compaction discards only the oldest messages and keeps
  // at most the recorded post-compaction message count.
  if (
    strategy ===
      "sliding-window"
  ) {
    messages.splice(
      0,
      Math.max(
        0,
        messages.length -
          afterMessageCount,
      ),
    );

    return;
  }

  if (
    strategy !==
      "summarise"
  ) {
    throw new Error(
      `Unsupported stored compaction strategy "${strategy}".`,
    );
  }

  if (
    typeof record.summary !==
      "string" ||
    record.summary.trim() ===
      ""
  ) {
    throw new Error(
      "Summarise compaction session record is missing its summary.",
    );
  }

  if (
    afterMessageCount <
      1
  ) {
    throw new Error(
      "Summarise compaction must retain at least its summary message.",
    );
  }

  const recentMessageCount =
    afterMessageCount -
    1;

  const recentMessages =
    recentMessageCount ===
      0
      ? []
      : messages.slice(
          -recentMessageCount,
        );

  messages.splice(
    0,
    messages.length,
    createCompactionSummaryMessage(
      record.summary,
    ),
    ...recentMessages,
  );
}

/**
 * Reconstructs resumable chat history by replaying session records in order.
 *
 * User and assistant message records are restored directly. A tool_result is
 * restored only when it immediately follows an assistant message containing a
 * valid matching Sky tool request. Background tool results that historically
 * returned control to the prompt are intentionally not injected back into the
 * model conversation. Compaction events mutate the accumulated history at the
 * point where they originally occurred.
 *
 * @param {readonly SessionRecord[]} records - Persisted records in log order.
 * @returns {ChatMessage[]} Reconstructed conversation suitable for resuming.
 * @throws {Error} If a stored compaction record cannot be replayed safely.
 */
export function reconstructSessionMessages(
  records:
    readonly SessionRecord[],
): ChatMessage[] {
  const messages:
    ChatMessage[] = [];

  for (
    const record of
    records
  ) {
    if (
      record.type ===
        "message" &&
      (
        record.role ===
          "user" ||
        record.role ===
          "assistant"
      ) &&
      typeof record.content ===
        "string"
    ) {
      messages.push({
        role:
          record.role,

        content:
          record.content,
      });

      continue;
    }

    // A stored tool result is meaningful to model history only if it can be
    // paired with the assistant tool request that immediately preceded it.
    if (
      record.type ===
        "tool_result" &&
      typeof record.tool ===
        "string" &&
      typeof record.content ===
        "string" &&
      typeof record.success ===
        "boolean"
    ) {
      const previousMessage =
        messages.at(
          -1,
        );

      // Orphaned tool results are ignored instead of manufacturing a request
      // that was not present in reconstructed history.
      if (
        previousMessage?.role !==
          "assistant"
      ) {
        continue;
      }

      // Re-parse the assistant message using the same tool protocol used by
      // the live runtime, then require the persisted tool name to match.
      const request =
        parseSkyToolRequest(
          previousMessage.content,
        );

      if (
        request ===
          null ||
        request.tool !==
          record.tool
      ) {
        continue;
      }

      const result:
        ToolExecutionResult = {
        success:
          record.success,

        output:
          record.content,
      };

      // Background tools that returned immediately to the interactive prompt
      // did not feed this result back through the normal model continuation
      // path, so resume reconstruction mirrors that behavior.
      if (
        shouldReturnToPromptAfterBackgroundTool(
          request,
          result,
        )
      ) {
        continue;
      }

      messages.push(
        createRestoredToolResultMessage(
          request.tool,
          result,
        ),
      );

      continue;
    }

    // Replay compaction chronologically so later records see the same reduced
    // history that existed in the original session.
    if (
      record.type ===
        "compaction"
    ) {
      applyCompactionRecord(
        messages,
        record,
      );
    }
  }

  return messages;
}

/**
 * Loads one session file and converts it into resumable runtime state.
 *
 * A session is resumable only when it contains a session_start record with a
 * non-empty working directory and reconstruction produces at least one chat
 * message. The latest non-empty model value appearing anywhere in the records
 * is retained. updatedAt comes from the final record when available.
 *
 * @param {string} filePath - Session JSONL file to load.
 * @returns {Promise<ResumableSession | null>} Reconstructed session, or null
 * when the file is structurally readable but lacks enough state to resume.
 * @throws {Error} If records cannot be read or reconstructed safely.
 *
 * Side effect: reads the session file from disk.
 */
export async function loadResumableSession(
  filePath:
    string,
): Promise<ResumableSession | null> {
  const records =
    await readSessionRecords(
      filePath,
    );

  // The first session_start record provides the original session identity,
  // working directory, and start timestamp used for resume metadata.
  const sessionStart =
    records.find(
      (
        record,
      ) =>
        record.type ===
          "session_start",
    );

  if (
    sessionStart ===
      undefined ||
    typeof sessionStart
      .workingDirectory !==
      "string" ||
    sessionStart
      .workingDirectory
      .trim() ===
      ""
  ) {
    return null;
  }

  const messages =
    reconstructSessionMessages(
      records,
    );

  if (
    messages.length ===
      0
  ) {
    return null;
  }

  // Walk the full log so the most recently recorded non-empty model wins,
  // reflecting model changes made during the original session.
  let model:
    string | undefined;

  for (
    const record of
    records
  ) {
    if (
      typeof record.model ===
        "string" &&
      record.model.trim() !==
        ""
    ) {
      model =
        record.model;
    }
  }

  // The last record timestamp reflects the most recent persisted activity,
  // regardless of its event type.
  const lastRecord =
    records.at(
      -1,
    );

  return {
    filePath,

    sessionId:
      sessionStart.sessionId,

    workingDirectory:
      resolve(
        sessionStart
          .workingDirectory,
      ),

    startedAt:
      sessionStart.timestamp,

    updatedAt:
      lastRecord
        ?.timestamp ??
      sessionStart.timestamp,

    model,

    recordCount:
      records.length,

    messages,
  };
}

/**
 * Finds the newest valid resumable session for a working directory.
 *
 * Only regular `.jsonl` files are considered. Candidates are ordered by
 * filesystem modification time from newest to oldest, then loaded until one
 * has a normalized working directory exactly matching the requested directory.
 * Invalid or unreadable individual candidate session files are skipped.
 *
 * A missing session directory is treated as "no resumable session" rather than
 * as an error.
 *
 * @param {string} workingDirectory - Working directory whose latest session is
 * requested.
 * @param {string} sessionDirectory - Directory containing session JSONL logs.
 * Defaults to ~/.sky-code/sessions.
 * @returns {Promise<ResumableSession | null>} Newest matching resumable
 * session, or null when none can be used.
 * @throws {Error} For directory-read failures other than ENOENT, or filesystem
 * errors encountered while inspecting candidate files.
 *
 * Side effects: reads the session directory, stats candidate files, and reads
 * candidate session logs until a match is found.
 */
export async function findLatestResumableSession(
  workingDirectory:
    string,

  sessionDirectory:
    string = join(
      homedir(),
      ".sky-code",
      "sessions",
    ),
): Promise<ResumableSession | null> {
  // Resolve both requested and stored working directories before comparing
  // them so equivalent relative/absolute spellings match consistently.
  const normalizedWorkingDirectory =
    resolve(
      workingDirectory,
    );

  let entries;

  try {
    entries =
      await readdir(
        sessionDirectory,
        {
          withFileTypes:
            true,
        },
      );
  } catch (error) {
    if (
      isRecord(
        error,
      ) &&
      // First-run installations may not have a sessions directory yet; this
      // is a normal "nothing to resume" condition.
      error.code ===
        "ENOENT"
    ) {
      return null;
    }

    throw error;
  }

  // Modification time is used only to choose search order; session metadata
  // is still validated by loadResumableSession before a file is returned.
  const files:
    Array<{
      filePath:
        string;

      modifiedAt:
        number;
    }> = [];

  for (
    const entry of
    entries
  ) {
    if (
      // Ignore directories and unrelated files that may coexist in the
      // sessions directory.
      !entry.isFile() ||
      !entry.name.endsWith(
        ".jsonl",
      )
    ) {
      continue;
    }

    const filePath =
      join(
        sessionDirectory,
        entry.name,
      );

    const details =
      await stat(
        filePath,
      );

    files.push({
      filePath,

      modifiedAt:
        details.mtimeMs,
    });
  }

  // Search newest files first so the first valid directory match is the
  // latest resumable session by filesystem modification time.
  files.sort(
    (
      left,
      right,
    ) =>
      right.modifiedAt -
      left.modifiedAt,
  );

  for (
    const file of
    files
  ) {
    let candidate:
      ResumableSession | null;

    try {
      candidate =
        await loadResumableSession(
          file.filePath,
        );
    // One corrupt or incompatible session log must not prevent discovery of
    // an older valid session.
    } catch {
      continue;
    }

    if (
      // loadResumableSession normalizes the stored directory with resolve(),
      // making this an exact normalized-path comparison.
      candidate
        ?.workingDirectory ===
      normalizedWorkingDirectory
    ) {
      return candidate;
    }
  }

  return null;
}
