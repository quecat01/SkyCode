/**
 * In-memory background-task lifecycle management for Sky Code.
 *
 * BackgroundTaskRegistry starts asynchronous work, tracks lifecycle state,
 * supports cooperative AbortSignal cancellation, publishes Notification hooks,
 * and optionally reports human-readable status updates.
 *
 * Completed, failed, and cancelled tasks remain available for inspection.
 * Public task reads return snapshot copies rather than the registry's mutable
 * task-state objects.
 */
import {
  randomUUID,
} from "node:crypto";

import type {
  HookRegistry,
  NotificationLevel,
} from "./hooks.js";

/**
 * Current lifecycle state of a registered background task.
 */
export type BackgroundTaskStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

/**
 * Lifecycle event emitted while a background task runs.
 *
 * A task emits `started`, may emit multiple `progress` events, and eventually
 * reaches `completed`, `failed`, or `cancelled`.
 */
export type BackgroundTaskLifecycleEvent =
  | "started"
  | "progress"
  | "completed"
  | "failed"
  | "cancelled";

/**
 * Snapshot of externally visible background-task state.
 *
 * Timestamps are ISO-8601 strings. Terminal tasks may expose result, error, or
 * cancellation information depending on how execution ended.
 */
export interface BackgroundTaskSnapshot {
  id: string;
  label: string;
  status: BackgroundTaskStatus;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  progressMessage?: string;
  result?: unknown;
  error?: string;
  cancellationReason?: string;
}

/**
 * Runtime services supplied to a BackgroundTaskRunner.
 *
 * signal communicates cooperative cancellation. reportProgress updates the
 * task snapshot and publishes a progress lifecycle event.
 */
export interface BackgroundTaskContext {
  signal: AbortSignal;

  reportProgress(
    message: string,
  ): Promise<void>;
}

/**
 * Asynchronous implementation of one background task.
 *
 * @param {BackgroundTaskContext} context - Cancellation and progress-reporting
 * facilities for the running task.
 * @returns {Promise<unknown>} Task result stored when execution succeeds.
 */
export type BackgroundTaskRunner = (
  context: BackgroundTaskContext,
) => Promise<unknown>;

/**
 * Optional observer that receives formatted task lifecycle updates.
 *
 * @param {string} line - Human-readable lifecycle status line.
 * @param {BackgroundTaskSnapshot} task - Snapshot of task state at event time.
 * @param {BackgroundTaskLifecycleEvent} event - Event being reported.
 * @returns {void | Promise<void>} Optional asynchronous reporting work.
 */
export type BackgroundTaskReporter = (
  line: string,
  task: BackgroundTaskSnapshot,
  event: BackgroundTaskLifecycleEvent,
) => void | Promise<void>;

/**
 * Optional dependencies used by BackgroundTaskRegistry.
 *
 * hookRegistry publishes lifecycle Notification hooks. reporter receives
 * formatted lifecycle lines. createId and now allow deterministic ID/time
 * behavior, particularly in tests.
 */
export interface BackgroundTaskRegistryOptions {
  hookRegistry?: HookRegistry;
  reporter?: BackgroundTaskReporter;
  createId?: () => string;
  now?: () => Date;
}

/**
 * Handle returned to the caller after a task is started.
 *
 * done resolves to the final task snapshot. cancel() requests cooperative
 * cancellation and reports whether an active task was found.
 */
export interface BackgroundTaskHandle {
  id: string;

  done:
    Promise<BackgroundTaskSnapshot>;

  cancel(
    reason?: string,
  ): boolean;
}

/**
 * Mutable internal state retained by BackgroundTaskRegistry for one task.
 *
 * Combines the current snapshot, cancellation controller, and final completion
 * promise.
 */
interface StoredBackgroundTask {
  snapshot: BackgroundTaskSnapshot;
  controller: AbortController;
  done: Promise<BackgroundTaskSnapshot>;
}

/**
 * Error used to represent intentional background-task cancellation.
 *
 * The registry treats this error, and standard errors named `AbortError`, as
 * cancellation rather than ordinary task failure.
 */
export class BackgroundTaskCancelledError
  extends Error {
  /**
   * Creates a background-task cancellation error.
   *
   * @param {string} message - Human-readable cancellation reason.
   */
  public constructor(
    message:
      string =
        "Background task cancelled.",
  ) {
    super(message);
    this.name =
      "BackgroundTaskCancelledError";
  }
}

/**
 * Validates and normalizes required task text.
 *
 * @param {string} value - Candidate text value.
 * @param {string} fieldName - Field label included in validation errors.
 * @returns {string} Trimmed non-empty value.
 * @throws {Error} If value is not a string or is empty after trimming.
 */
function requireNonEmptyText(
  value: string,
  fieldName: string,
): string {
  if (
    typeof value !==
      "string" ||
    value.trim() ===
      ""
  ) {
    throw new Error(
      `${fieldName} must be a non-empty string.`,
    );
  }

  return value.trim();
}

/**
 * Creates a shallow copy of task state before exposing it externally.
 *
 * The snapshot object itself is isolated from registry mutation. The optional
 * unknown result payload is intentionally not deep-cloned.
 *
 * @param {BackgroundTaskSnapshot} snapshot - Task snapshot to copy.
 * @returns {BackgroundTaskSnapshot} Shallow copy of the snapshot.
 */
function cloneTaskSnapshot(
  snapshot:
    BackgroundTaskSnapshot,
): BackgroundTaskSnapshot {
  return {
    ...snapshot,
  };
}

/**
 * Converts an unknown failure into readable task-error text.
 *
 * @param {unknown} error - Thrown or rejected value.
 * @returns {string} Error.message when available, otherwise String(error).
 */
function describeError(
  error: unknown,
): string {
  if (
    error instanceof
      Error
  ) {
    return error.message;
  }

  return String(
    error,
  );
}

/**
 * Determines whether an execution error represents task cancellation.
 *
 * @param {unknown} error - Failure value to inspect.
 * @returns {boolean} True for BackgroundTaskCancelledError or an Error whose
 * name is `AbortError`.
 */
function isAbortError(
  error: unknown,
): boolean {
  return (
    error instanceof
      BackgroundTaskCancelledError ||
    (
      error instanceof
        Error &&
      error.name ===
        "AbortError"
    )
  );
}

/**
 * Maps a task lifecycle event to Notification hook severity.
 *
 * @param {BackgroundTaskLifecycleEvent} event - Event to classify.
 * @returns {NotificationLevel} Error for failure, warning for cancellation,
 * otherwise informational.
 */
function notificationLevelForEvent(
  event:
    BackgroundTaskLifecycleEvent,
): NotificationLevel {
  switch (event) {
    case "failed":
      return "error";

    case "cancelled":
      return "warning";

    default:
      return "info";
  }
}

/**
 * Creates the human-readable Notification hook message for a lifecycle event.
 *
 * @param {BackgroundTaskLifecycleEvent} event - Lifecycle event being emitted.
 * @param {BackgroundTaskSnapshot} snapshot - Current task state.
 * @returns {string} Notification message describing the event.
 */
function notificationMessageForEvent(
  event:
    BackgroundTaskLifecycleEvent,
  snapshot:
    BackgroundTaskSnapshot,
): string {
  switch (event) {
    case "started":
      return `Background task "${snapshot.label}" started.`;

    case "progress":
      return `Background task "${snapshot.label}" progress: ${snapshot.progressMessage ?? "Working..."}`;

    case "completed":
      return `Background task "${snapshot.label}" completed.`;

    case "failed":
      return `Background task "${snapshot.label}" failed: ${snapshot.error ?? "Unknown error."}`;

    case "cancelled":
      return `Background task "${snapshot.label}" cancelled: ${snapshot.cancellationReason ?? "Cancellation requested."}`;
  }
}

/**
 * Formats one lifecycle event as a concise task status line.
 *
 * @param {BackgroundTaskLifecycleEvent} event - Event to format.
 * @param {BackgroundTaskSnapshot} snapshot - Current task state.
 * @returns {string} Status line prefixed with the background-task ID.
 */
export function formatBackgroundTaskStatusLine(
  event:
    BackgroundTaskLifecycleEvent,
  snapshot:
    BackgroundTaskSnapshot,
): string {
  const prefix =
    `[Task ${snapshot.id}]`;

  switch (event) {
    case "started":
      return `${prefix} Started: ${snapshot.label}`;

    case "progress":
      return `${prefix} Progress: ${snapshot.progressMessage ?? "Working..."}`;

    case "completed":
      return `${prefix} Completed: ${snapshot.label}`;

    case "failed":
      return `${prefix} Failed: ${snapshot.error ?? "Unknown error."}`;

    case "cancelled":
      return `${prefix} Cancelled: ${snapshot.cancellationReason ?? "Cancellation requested."}`;
  }
}

/**
 * Registry responsible for starting, inspecting, cancelling, and reporting
 * asynchronous background tasks.
 *
 * Tasks are kept in memory after reaching a terminal state so callers can query
 * their final snapshots.
 */
export class BackgroundTaskRegistry {
  private readonly tasks =
    new Map<
      string,
      StoredBackgroundTask
    >();

  private readonly hookRegistry?:
    HookRegistry;

  private readonly reporter?:
    BackgroundTaskReporter;

  private readonly createId:
    () => string;

  private readonly now:
    () => Date;

  /**
   * Creates a background-task registry.
   *
   * @param {BackgroundTaskRegistryOptions} options - Optional hooks, reporter,
   * ID factory, and clock.
   */
  public constructor(
    options:
      BackgroundTaskRegistryOptions = {},
  ) {
    this.hookRegistry =
      options.hookRegistry;

    this.reporter =
      options.reporter;

    this.createId =
      options.createId ??
      randomUUID;

    this.now =
      options.now ??
      (() => new Date());
  }

  /**
   * Starts and registers one background task.
   *
   * The task label, runner, and generated ID are validated before registration.
   * IDs must be unique within this registry. Execution is represented by the
   * returned done promise and may be cooperatively cancelled through the handle.
   *
   * @param {string} labelValue - Human-readable task label.
   * @param {BackgroundTaskRunner} runner - Asynchronous task implementation.
   * @returns {BackgroundTaskHandle} Task ID, completion promise, and cancel API.
   * @throws {Error} If label/ID validation fails, runner is not a function, or
   * the generated task ID is already registered.
   *
   * Side effects: creates task state, starts asynchronous execution, stores the
   * task in memory, and may emit lifecycle notifications.
   */
  public start(
    labelValue: string,
    runner:
      BackgroundTaskRunner,
  ): BackgroundTaskHandle {
    const label =
      requireNonEmptyText(
        labelValue,
        "Background task label",
      );

    if (
      typeof runner !==
        "function"
    ) {
      throw new Error(
        "Background task runner must be a function.",
      );
    }

    const id =
      requireNonEmptyText(
        this.createId(),
        "Background task ID",
      );

    if (
      this.tasks.has(
        id,
      )
    ) {
      throw new Error(
        `Background task ID "${id}" is already in use.`,
      );
    }

    const timestamp =
      this.now()
        .toISOString();

    const storedTask:
      StoredBackgroundTask = {
      snapshot: {
        id,
        label,
        status:
          "running",
        startedAt:
          timestamp,
        updatedAt:
          timestamp,
      },
      controller:
        new AbortController(),
      done:
        Promise.resolve({
          id,
          label,
          status:
            "running",
          startedAt:
            timestamp,
          updatedAt:
            timestamp,
        }),
    };

    storedTask.done =
      this.executeTask(
        storedTask,
        runner,
      );

    this.tasks.set(
      id,
      storedTask,
    );

    return {
      id,
      done:
        storedTask.done,
      cancel:
        (
          reason?: string,
        ): boolean =>
          this.cancel(
            id,
            reason,
          ),
    };
  }

  /**
   * Looks up the current state of one background task.
   *
   * @param {string} id - Exact registered task ID.
   * @returns {BackgroundTaskSnapshot | null} Snapshot copy when found,
   * otherwise null.
   */
  public get(
    id: string,
  ): BackgroundTaskSnapshot | null {
    const storedTask =
      this.tasks.get(
        id,
      );

    return storedTask
      ? cloneTaskSnapshot(
          storedTask.snapshot,
        )
      : null;
  }

  /**
   * Lists registered tasks in deterministic start-time and ID order.
   *
   * @param {boolean} includeFinished - Whether terminal tasks should be included.
   * @returns {BackgroundTaskSnapshot[]} Sorted snapshot copies.
   */
  public list(
    includeFinished:
      boolean = true,
  ): BackgroundTaskSnapshot[] {
    return [
      ...this.tasks.values(),
    ]
      .map(
        (
          storedTask,
        ) =>
          cloneTaskSnapshot(
            storedTask.snapshot,
          ),
      )
      .filter(
        (
          snapshot,
        ) =>
          includeFinished ||
          snapshot.status ===
            "running",
      )
      .sort(
        (
          left,
          right,
        ) =>
          left.startedAt.localeCompare(
            right.startedAt,
          ) ||
          left.id.localeCompare(
            right.id,
          ),
      );
  }

  /**
   * Counts currently running background tasks.
   *
   * @returns {number} Number of tasks whose status is `running`.
   */
  public countRunning():
    number {
    return this.list(
      false,
    ).length;
  }

  /**
   * Requests cooperative cancellation of a running task.
   *
   * The cancellation reason, progress text, and update timestamp are recorded
   * before its AbortController is aborted. The task runner must observe its
   * AbortSignal for immediate interruption; executeTask() also checks the signal
   * after runner completion.
   *
   * @param {string} idValue - Task ID to cancel.
   * @param {string} reasonValue - Human-readable cancellation reason.
   * @returns {boolean} True when cancellation was requested for a running task;
   * false for blank, unknown, or already-finished IDs.
   * @throws {Error} If a matched running task is given an empty reason.
   *
   * Side effects: mutates task state and aborts its AbortController.
   */
  public cancel(
    idValue: string,
    reasonValue:
      string =
        "Cancellation requested by the user.",
  ): boolean {
    const id =
      idValue.trim();

    if (
      id ===
      ""
    ) {
      return false;
    }

    const storedTask =
      this.tasks.get(
        id,
      );

    if (
      !storedTask ||
      storedTask.snapshot
        .status !==
        "running"
    ) {
      return false;
    }

    const reason =
      requireNonEmptyText(
        reasonValue,
        "Background task cancellation reason",
      );

    storedTask.snapshot
      .cancellationReason =
      reason;

    storedTask.snapshot
      .progressMessage =
      "Cancellation requested.";

    storedTask.snapshot
      .updatedAt =
      this.now()
        .toISOString();

    storedTask.controller
      .abort(
        new BackgroundTaskCancelledError(
          reason,
        ),
      );

    return true;
  }

  /**
   * Cancels all tasks that are running when this method is called.
   *
   * The active task set is captured first, each task receives the same
   * cancellation reason, and their completion promises are then awaited.
   *
   * @param {string} reason - Cancellation reason applied to running tasks.
   * @returns {Promise<BackgroundTaskSnapshot[]>} Final snapshots for tasks that
   * were running at the start of this operation.
   * @throws {Error} If cancellation validation or an awaited completion rejects.
   *
   * Side effects: requests cancellation of all captured running tasks.
   */
  public async cancelAll(
    reason:
      string =
        "Sky Code is closing.",
  ): Promise<
    BackgroundTaskSnapshot[]
  > {
    const runningTasks =
      [
        ...this.tasks.values(),
      ].filter(
        (
          storedTask,
        ) =>
          storedTask.snapshot
            .status ===
          "running",
      );

    for (
      const storedTask of
      runningTasks
    ) {
      this.cancel(
        storedTask.snapshot.id,
        reason,
      );
    }

    return Promise.all(
      runningTasks.map(
        (
          storedTask,
        ) =>
          storedTask.done,
      ),
    );
  }

  /**
   * Executes one task and manages its complete lifecycle.
   *
   * The started event is emitted before runner execution. Cancellation is
   * checked both before and after the runner so a task cannot be marked complete
   * after cancellation simply because its runner ignored AbortSignal.
   *
   * The runner's reportProgress callback validates progress text, updates the
   * snapshot timestamp/message, and emits progress events. Terminal execution
   * becomes completed, failed, or cancelled and receives a completedAt timestamp
   * before the corresponding lifecycle event is emitted.
   *
   * @param {StoredBackgroundTask} storedTask - Mutable internal task record.
   * @param {BackgroundTaskRunner} runner - Asynchronous task implementation.
   * @returns {Promise<BackgroundTaskSnapshot>} Final shallow snapshot.
   *
   * Side effects: invokes the task runner, mutates task state, and emits
   * lifecycle hooks/reporter callbacks.
   */
  private async executeTask(
    storedTask:
      StoredBackgroundTask,
    runner:
      BackgroundTaskRunner,
  ): Promise<
    BackgroundTaskSnapshot
  > {
    try {
      await this.emitLifecycleEvent(
        "started",
        storedTask.snapshot,
      );

      if (
        storedTask.controller
          .signal.aborted
      ) {
        throw new BackgroundTaskCancelledError(
          storedTask.snapshot
            .cancellationReason ??
          "Cancellation requested.",
        );
      }

      const result =
        await runner({
          signal:
            storedTask.controller
              .signal,

          reportProgress:
            async (
              messageValue:
                string,
            ): Promise<void> => {
              const message =
                requireNonEmptyText(
                  messageValue,
                  "Background task progress message",
                );

              if (
                storedTask.controller
                  .signal.aborted
              ) {
                throw new BackgroundTaskCancelledError(
                  storedTask.snapshot
                    .cancellationReason ??
                  "Cancellation requested.",
                );
              }

              if (
                storedTask.snapshot
                  .status !==
                "running"
              ) {
                return;
              }

              storedTask.snapshot
                .progressMessage =
                message;

              storedTask.snapshot
                .updatedAt =
                this.now()
                  .toISOString();

              await this.emitLifecycleEvent(
                "progress",
                storedTask.snapshot,
              );
            },
        });

      if (
        storedTask.controller
          .signal.aborted
      ) {
        throw new BackgroundTaskCancelledError(
          storedTask.snapshot
            .cancellationReason ??
          "Cancellation requested.",
        );
      }

      storedTask.snapshot
        .status =
        "completed";

      storedTask.snapshot
        .result =
        result;

      storedTask.snapshot
        .progressMessage =
        undefined;

      const completedAt =
        this.now()
          .toISOString();

      storedTask.snapshot
        .updatedAt =
        completedAt;

      storedTask.snapshot
        .completedAt =
        completedAt;

      await this.emitLifecycleEvent(
        "completed",
        storedTask.snapshot,
      );
    } catch (error) {
      if (
        storedTask.controller
          .signal.aborted ||
        isAbortError(
          error,
        )
      ) {
        storedTask.snapshot
          .status =
          "cancelled";

        storedTask.snapshot
          .cancellationReason =
          storedTask.snapshot
            .cancellationReason ??
          describeError(
            error,
          );
      } else {
        storedTask.snapshot
          .status =
          "failed";

        storedTask.snapshot
          .error =
          describeError(
            error,
          );
      }

      storedTask.snapshot
        .progressMessage =
        undefined;

      const completedAt =
        this.now()
          .toISOString();

      storedTask.snapshot
        .updatedAt =
        completedAt;

      storedTask.snapshot
        .completedAt =
        completedAt;

      await this.emitLifecycleEvent(
        storedTask.snapshot
          .status ===
          "cancelled"
          ? "cancelled"
          : "failed",
        storedTask.snapshot,
      );
    }

    return cloneTaskSnapshot(
      storedTask.snapshot,
    );
  }

  /**
   * Publishes a task lifecycle event to configured observers.
   *
   * A snapshot copy is created before notification. Notification hooks run
   * first, followed by the optional reporter, so observer code does not receive
   * the mutable registry snapshot directly.
   *
   * @param {BackgroundTaskLifecycleEvent} event - Lifecycle event to emit.
   * @param {BackgroundTaskSnapshot} snapshot - Current internal task snapshot.
   * @returns {Promise<void>} Resolves after all configured observers complete.
   * @throws {Error} If a Notification hook or reporter rejects.
   *
   * Side effects: may invoke Notification hooks and the task reporter.
   */
  private async emitLifecycleEvent(
    event:
      BackgroundTaskLifecycleEvent,
    snapshot:
      BackgroundTaskSnapshot,
  ): Promise<void> {
    const safeSnapshot =
      cloneTaskSnapshot(
        snapshot,
      );

    if (
      this.hookRegistry
    ) {
      await this.hookRegistry.run(
        "Notification",
        {
          level:
            notificationLevelForEvent(
              event,
            ),
          message:
            notificationMessageForEvent(
              event,
              safeSnapshot,
            ),
          metadata: {
            event:
              `background_task_${event}`,
            taskId:
              safeSnapshot.id,
            taskLabel:
              safeSnapshot.label,
            taskStatus:
              safeSnapshot.status,
            progressMessage:
              safeSnapshot
                .progressMessage,
            error:
              safeSnapshot.error,
            cancellationReason:
              safeSnapshot
                .cancellationReason,
          },
        },
      );
    }

    if (
      this.reporter
    ) {
      await this.reporter(
        formatBackgroundTaskStatusLine(
          event,
          safeSnapshot,
        ),
        safeSnapshot,
        event,
      );
    }
  }
}
