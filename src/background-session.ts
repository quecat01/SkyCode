import type {
  BackgroundTaskReporter,
} from "./background.js";

import type {
  SessionLogger,
} from "./session.js";

export function createBackgroundSessionReporter(
  sessionLogger:
    SessionLogger,
): BackgroundTaskReporter {
  return async (
    line,
    task,
    event,
  ): Promise<void> => {
    await sessionLogger.append({
      type:
        "background_task",

      role:
        "system",

      content:
        line,

      backgroundEvent:
        event,

      taskId:
        task.id,

      taskLabel:
        task.label,

      taskStatus:
        task.status,

      taskStartedAt:
        task.startedAt,

      taskUpdatedAt:
        task.updatedAt,

      taskCompletedAt:
        task.completedAt,

      progressMessage:
        task.progressMessage,

      error:
        task.error,

      cancellationReason:
        task.cancellationReason,
    });
  };
}
