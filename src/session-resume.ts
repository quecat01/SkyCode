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

  const strategy =
    record.strategy ??
    "summarise";

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

      if (
        previousMessage?.role !==
          "assistant"
      ) {
        continue;
      }

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

export async function loadResumableSession(
  filePath:
    string,
): Promise<ResumableSession | null> {
  const records =
    await readSessionRecords(
      filePath,
    );

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
      error.code ===
        "ENOENT"
    ) {
      return null;
    }

    throw error;
  }

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
    } catch {
      continue;
    }

    if (
      candidate
        ?.workingDirectory ===
      normalizedWorkingDirectory
    ) {
      return candidate;
    }
  }

  return null;
}
