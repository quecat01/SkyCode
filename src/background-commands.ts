import type {
  BackgroundTaskSnapshot,
} from "./background.js";

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

const TASK_COMMAND_USAGE =
  "Usage: /tasks or /tasks cancel <task-id>";

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
