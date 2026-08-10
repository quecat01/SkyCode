/**
 * Parsing, execution, and terminal formatting for Sky Code `/tasks` commands.
 *
 * The command supports listing all background tasks and requesting cancellation
 * of one running task by ID. Parsing is deliberately separate from execution so
 * command syntax can be tested independently from the background-task registry.
 */
import type {
  BackgroundTaskSnapshot,
} from "./background.js";

/**
 * Parsed representation of a `/tasks` command.
 *
 * `list` displays known tasks, `cancel` targets one task ID, and `invalid`
 * carries a user-facing usage message for recognized but malformed commands.
 */
export type BackgroundTasksCommand =
  | {
      kind:
        "list";
    }
  | {
      kind:
        "cancel";

      id:
        string;
    }
  | {
      kind:
        "invalid";

      message:
        string;
    };

/**
 * User-facing syntax help returned for malformed `/tasks` commands.
 */
const TASK_COMMAND_USAGE =
  "Usage: /tasks or /tasks cancel <task-id>";

/**
 * Parses raw terminal input as a Sky Code background-task command.
 *
 * Input that does not begin with the exact `/tasks` command token returns null
 * so other command handlers may process it. Bare `/tasks` becomes a list
 * command. Cancellation requires exactly `/tasks cancel <task-id>`; any other
 * recognized `/tasks` syntax becomes an `invalid` command carrying usage text.
 *
 * @param {string} input - Raw terminal command text.
 * @returns {BackgroundTasksCommand | null} Parsed command, or null when input is
 * not a `/tasks` command.
 */
export function parseBackgroundTasksCommand(
  input:
    string,
): BackgroundTasksCommand | null {
  const trimmedInput =
    input.trim();

  if (
    !/^\/tasks(?:\s|$)/.test(
      trimmedInput,
    )
  ) {
    return null;
  }

  const parts =
    trimmedInput.split(
      /\s+/,
    );

  if (
    parts.length ===
      1
  ) {
    return {
      kind:
        "list",
    };
  }

  if (
    parts[1] !==
      "cancel"
  ) {
    return {
      kind:
        "invalid",

      message:
        TASK_COMMAND_USAGE,
    };
  }

  if (
    parts.length !==
      3 ||
    parts[2].trim() ===
      ""
  ) {
    return {
      kind:
        "invalid",

      message:
        TASK_COMMAND_USAGE,
    };
  }

  return {
    kind:
      "cancel",

    id:
      parts[2],
  };
}

/**
 * Selects the most useful one-line detail for a task snapshot.
 *
 * Running tasks show their latest progress when available. Completed tasks use
 * a fixed success message, while failed and cancelled tasks prefer their stored
 * error or cancellation reason with a fallback.
 *
 * @param {BackgroundTaskSnapshot} task - Task snapshot to describe.
 * @returns {string | null} Status-specific detail, or null when a running task
 * has no progress message.
 */
function taskDetail(
  task:
    BackgroundTaskSnapshot,
): string | null {
  switch (
    task.status
  ) {
    case "running":
      return task.progressMessage ??
        null;

    case "completed":
      return "Completed successfully.";

    case "failed":
      return task.error ??
        "Unknown error.";

    case "cancelled":
      return task.cancellationReason ??
        "Cancellation requested.";
  }
}

/**
 * Formats one task snapshot as a compact status-list row.
 *
 * @param {BackgroundTaskSnapshot} task - Task snapshot to format.
 * @returns {string} Status, task ID, label, and optional status detail.
 */
function formatTask(
  task:
    BackgroundTaskSnapshot,
): string {
  const detail =
    taskDetail(
      task,
    );

  return [
    `[${task.status}]`,
    task.id,
    "-",
    task.label,
    detail
      ? `- ${detail}`
      : "",
  ]
    .filter(
      (
        section,
      ) =>
        section !==
          "",
    )
    .join(
      " ",
    );
}

/**
 * Formats a collection of task snapshots for terminal display.
 *
 * Empty input receives a dedicated session message. Otherwise the first line
 * reports total and running counts, followed by one formatted row per task in
 * the order supplied by the runtime.
 *
 * @param {readonly BackgroundTaskSnapshot[]} tasks - Task snapshots to display.
 * @returns {string} Multi-line background-task summary.
 */
export function formatBackgroundTaskList(
  tasks:
    readonly BackgroundTaskSnapshot[],
): string {
  if (
    tasks.length ===
      0
  ) {
    return "No background tasks have been started in this session.";
  }

  const runningCount =
    tasks.filter(
      (
        task,
      ) =>
        task.status ===
          "running",
    ).length;

  return [
    `Background tasks: ${tasks.length} total, ${runningCount} running`,
    ...tasks.map(
      formatTask,
    ),
  ].join(
    "\n",
  );
}


/**
 * Minimal background-task operations required by `/tasks` command execution.
 *
 * BackgroundTaskRegistry satisfies this shape while tests or alternate runtimes
 * can provide smaller stand-ins.
 */
export interface BackgroundTasksCommandRuntime {
  list(
    includeFinished?:
      boolean,
  ): BackgroundTaskSnapshot[];

  get(
    id:
      string,
  ): BackgroundTaskSnapshot | null;

  cancel(
    id:
      string,
    reason?:
      string,
  ): boolean;
}

/**
 * Executes a parsed `/tasks` command against a background-task runtime.
 *
 * Invalid commands return their parser-provided usage message. List commands
 * request finished and running tasks. Cancel commands first verify that the task
 * exists and is still running, then request cancellation using the standard
 * user-request reason.
 *
 * The cancellation API may still return false after the earlier status check,
 * for example if task state changes between get() and cancel(); that race is
 * reported as an inability to cancel rather than assumed successful.
 *
 * @param {BackgroundTasksCommand} command - Parsed background-task command.
 * @param {BackgroundTasksCommandRuntime} runtime - Task lookup/list/cancel API.
 * @returns {string} User-facing command result.
 *
 * Side effects: list commands query runtime task state; cancel commands may
 * request cooperative cancellation of a running task.
 */
export function executeBackgroundTasksCommand(
  command:
    BackgroundTasksCommand,
  runtime:
    BackgroundTasksCommandRuntime,
): string {
  if (
    command.kind ===
      "invalid"
  ) {
    return command.message;
  }

  if (
    command.kind ===
      "list"
  ) {
    return formatBackgroundTaskList(
      runtime.list(
        true,
      ),
    );
  }

  const task =
    runtime.get(
      command.id,
    );

  if (
    !task
  ) {
    return `Background task "${command.id}" was not found.`;
  }

  if (
    task.status !==
      "running"
  ) {
    return `Background task "${command.id}" is already ${task.status}.`;
  }

  const cancelled =
    runtime.cancel(
      command.id,
      "Cancellation requested by the user.",
    );

  if (
    !cancelled
  ) {
    return `Unable to cancel background task "${command.id}".`;
  }

  return `Cancellation requested for background task "${command.id}".`;
}
