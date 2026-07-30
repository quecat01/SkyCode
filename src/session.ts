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

export type SessionEventType =
  | "session_start"
  | "message"
  | "tool_result"
  | "compaction"
  | "session_end"
  | "background_task";

export type SessionRole =
  | "user"
  | "assistant"
  | "system"
  | "tool";

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

export type SessionRecordInput =
  Omit<
    SessionRecord,
    "timestamp" | "sessionId"
  >;

export interface SessionLogger {
  sessionId:
    string;

  filePath:
    string;

  append(
    record:
      SessionRecordInput,
  ): Promise<void>;
}

function createSafeTimestamp():
  string {
  return new Date()
    .toISOString()
    .replace(
      /[:.]/g,
      "-",
    );
}

export async function createSessionLogger(
  sessionDirectory:
    string = join(
      homedir(),
      ".sky-code",
      "sessions",
    ),
): Promise<SessionLogger> {
  await mkdir(
    sessionDirectory,
    {
      recursive:
        true,
    },
  );

  const sessionId =
    createUuid();

  const filePath =
    join(
      sessionDirectory,
      `${createSafeTimestamp()}-${sessionId}.jsonl`,
    );

  let writeQueue:
    Promise<void> =
      Promise.resolve();

  async function append(
    record:
      SessionRecordInput,
  ): Promise<void> {
    const completeRecord:
      SessionRecord = {
        timestamp:
          new Date()
            .toISOString(),
        sessionId,
        ...record,
      };

    const line =
      `${JSON.stringify(
        completeRecord,
      )}\n`;

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
