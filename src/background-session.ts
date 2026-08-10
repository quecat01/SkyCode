/**
 * Session-log integration for Sky Code background-task lifecycle events.
 *
 * This module adapts BackgroundTaskReporter callbacks into structured session
 * records so task starts, progress updates, completion, failures, and
 * cancellations remain part of the persistent Sky Code session history.
 */
import type {
  BackgroundTaskReporter,
} from "./background.js";

import type {
  SessionLogger,
} from "./session.js";

/**
 * Creates a background-task reporter that persists lifecycle events.
 *
 * Every reporter invocation appends a `background_task` system record containing
 * the already-formatted status line plus the lifecycle event, task identity,
 * status, timestamps, progress, error, and cancellation metadata from the
 * supplied snapshot.
 *
 * Optional snapshot fields are passed through as undefined when they do not
 * apply to the current lifecycle state.
 *
 * @param {SessionLogger} sessionLogger - Session logger that receives structured
 * background-task records.
 * @returns {BackgroundTaskReporter} Async reporter suitable for
 * BackgroundTaskRegistry.
 * @throws {Error} If SessionLogger.append() rejects while recording an event.
 *
 * Side effect: each invocation of the returned reporter appends one record to
 * the session log.
 */
export function createBackgroundSessionReporter(
  sessionLogger:
    SessionLogger,
): BackgroundTaskReporter {
  // Preserve the complete lifecycle snapshot in structured fields rather than
  // relying only on the human-readable status line for later session analysis.
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
