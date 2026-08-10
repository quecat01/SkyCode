/**
 * Persistent JSONL session logging for Sky Code conversations and runtime
 * activity.
 *
 * Each logger receives a UUID session identifier and timestamped log path.
 * Callers append typed session events while this module supplies the session
 * ID and event timestamp automatically.
 *
 * Appends are serialized through an internal promise chain so concurrent
 * callers cannot race writes to the same session log.
 */
import {
  appendFile,
  mkdir,
} from "node:fs/promises";

import {
  homedir,
} from "node:os";

import {
  join,
} from "node:path";

import {
  v4 as createUuid,
} from "uuid";

/**
 * Event categories that may be recorded in a Sky Code session log.
 *
 * Covers session lifecycle, conversation messages, tool results, compaction,
 * and background-task activity.
 */
export type SessionEventType =
  | "session_start"
  | "message"
  | "tool_result"
  | "compaction"
  | "session_end"
  | "background_task";

/**
 * Conversation role associated with message-oriented session records.
 */
export type SessionRole =
  | "user"
  | "assistant"
  | "system"
  | "tool";

/**
 * One fully materialized JSONL record in a Sky Code session log.
 *
 * timestamp, sessionId, and type identify every event. Optional fields carry
 * event-specific metadata for messages, tool execution, compaction, and
 * background-task lifecycle updates.
 *
 * Background-task fields record task identity, lifecycle state, timestamps,
 * progress, errors, and cancellation details. Message/tool fields record role,
 * content, working directory, model, tool name, and success state. Compaction
 * fields record before/after counts, token estimates, strategy details,
 * dropped tool-output counts, and generated summaries.
 */
export interface SessionRecord {
  timestamp:
    string;

  sessionId:
    string;

  type:
    SessionEventType;


  backgroundEvent?:
    | "started"
    | "progress"
    | "completed"
    | "failed"
    | "cancelled";

  taskId?:
    string;

  taskLabel?:
    string;

  taskStatus?:
    | "running"
    | "completed"
    | "failed"
    | "cancelled";

  taskStartedAt?:
    string;

  taskUpdatedAt?:
    string;

  taskCompletedAt?:
    string;

  progressMessage?:
    string;

  error?:
    string;

  cancellationReason?:
    string;
  role?:
    SessionRole;

  content?:
    string;

  workingDirectory?:
    string;

  model?:
    string;

  tool?:
    string;

  success?:
    boolean;

  reason?:
    string;

  beforeMessageCount?:
    number;

  afterMessageCount?:
    number;

  estimatedTokens?:
    number;

  estimatedTokensAfter?:
    number;

  estimatedTokenReduction?:
    number;

  compactedTurnCount?:
    number;

  strategy?:
    string;

  droppedToolOutputCount?:
    number;

  summary?:
    string;
}

/**
 * Record shape accepted from session-logging callers.
 *
 * timestamp and sessionId are omitted because append() generates those values
 * centrally for every event written by a logger.
 */
export type SessionRecordInput =
  Omit<
    SessionRecord,
    "timestamp" | "sessionId"
  >;

/**
 * Runtime handle for one persistent Sky Code session log.
 *
 * sessionId is shared by every record written through the logger, filePath
 * identifies the JSONL destination, and append() serializes writes in call
 * order.
 */
export interface SessionLogger {
  sessionId:
    string;

  filePath:
    string;

  /**
   * Queues one event for persistent JSONL storage.
   *
   * @param {SessionRecordInput} record - Event-specific data excluding the
   * logger-owned timestamp and session ID.
   * @returns {Promise<void>} Resolves after the queued record is appended.
   *
   * Side effect: appends one UTF-8 JSON line to the session log.
   */
  append(
    record:
      SessionRecordInput,
  ): Promise<void>;
}

/**
 * Creates an ISO-derived UTC timestamp suitable for a session filename.
 *
 * Colons and the fractional-seconds period are replaced with hyphens while the
 * rest of the ISO timestamp is preserved.
 *
 * @returns {string} Filesystem-friendly UTC timestamp.
 */
function createSafeTimestamp():
  string {
  // ISO timestamps contain colons and a period; replacing these separators
  // produces the filename-safe form used for session logs.
  return new Date()
    .toISOString()
    .replace(
      /[:.]/g,
      "-",
    );
}

/**
 * Creates a logger for one Sky Code session.
 *
 * Ensures the session directory exists, creates a new UUID, builds a unique
 * timestamp-plus-UUID JSONL path, and initializes an ordered write queue.
 * The log file itself is not created until append() performs the first write.
 *
 * @param {string} sessionDirectory - Directory used to store session logs.
 * Defaults to ~/.sky-code/sessions.
 * @returns {Promise<SessionLogger>} Logger containing the generated session ID,
 * log path, and append function.
 * @throws {Error} If the session directory cannot be created.
 *
 * Side effect: may create the session directory recursively.
 */
export async function createSessionLogger(
  sessionDirectory:
    string = join(
      homedir(),
      ".sky-code",
      "sessions",
    ),
): Promise<SessionLogger> {
  // Recursive creation supports first-run operation when ~/.sky-code or its
  // sessions directory does not yet exist.
  await mkdir(
    sessionDirectory,
    {
      recursive:
        true,
    },
  );

  // Session identity uses a UUID rather than relying on the timestamp alone.
  const sessionId =
    createUuid();

  // Timestamp makes logs naturally sortable while the UUID prevents filename
  // collisions between sessions created at nearly the same instant.
  const filePath =
    join(
      sessionDirectory,
      `${createSafeTimestamp()}-${sessionId}.jsonl`,
    );

  // Begin with a resolved promise so every append can chain through the same
  // serialization point.
  let writeQueue:
    Promise<void> =
      Promise.resolve();

  /**
   * Adds logger-owned metadata and queues one JSONL record for disk storage.
   *
   * Multiple append calls may arrive before earlier writes complete. Chaining
   * each write onto writeQueue preserves call order and avoids overlapping
   * appendFile operations for this logger.
   *
   * The appendFile call requests mode 0600 when it creates the session file,
   * restricting the new log to owner read/write permissions.
   *
   * @param {SessionRecordInput} record - Caller-supplied event data.
   * @returns {Promise<void>} Resolves when this queued write completes.
   * @throws {Error} If this or an earlier queued append fails.
   *
   * Side effect: appends one UTF-8 JSONL record to the session file.
   */
  async function append(
    record:
      SessionRecordInput,
  ): Promise<void> {
    // Assign timestamp and session identity at append time so callers only
    // provide fields specific to the event being recorded.
    const completeRecord:
      SessionRecord = {
        timestamp:
          new Date()
            .toISOString(),
        sessionId,
        ...record,
      };

    // JSONL represents each complete event as one JSON object followed by a
    // newline.
    const line =
      `${JSON.stringify(
        completeRecord,
      )}\n`;

    // Chaining serializes writes. No rejection recovery is installed here,
    // so a failed queued write also causes later writes chained from it to
    // reject instead of silently skipping the earlier failure.
    writeQueue =
      writeQueue.then(
        async () => {
          await appendFile(
            filePath,
            line,
            {
              encoding:
                "utf8",
              mode:
                0o600,
            },
          );
        },
      );

    return writeQueue;
  }

  return {
    sessionId,
    filePath,
    append,
  };
}
