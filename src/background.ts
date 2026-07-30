import {
  randomUUID,
} from "node:crypto";

import type {
  HookRegistry,
  NotificationLevel,
} from "./hooks.js";

export type BackgroundTaskStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type BackgroundTaskLifecycleEvent =
  | "started"
  | "progress"
  | "completed"
  | "failed"
  | "cancelled";

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

export interface BackgroundTaskContext {
  signal: AbortSignal;

  reportProgress(
    message: string,
  ): Promise<void>;
}

export type BackgroundTaskRunner = (
  context: BackgroundTaskContext,
) => Promise<unknown>;

export type BackgroundTaskReporter = (
  line: string,
  task: BackgroundTaskSnapshot,
  event: BackgroundTaskLifecycleEvent,
) => void | Promise<void>;

export interface BackgroundTaskRegistryOptions {
  hookRegistry?: HookRegistry;
  reporter?: BackgroundTaskReporter;
  createId?: () => string;
  now?: () => Date;
}

export interface BackgroundTaskHandle {
  id: string;

  done:
    Promise<BackgroundTaskSnapshot>;

  cancel(
    reason?: string,
  ): boolean;
}

interface StoredBackgroundTask {
  snapshot: BackgroundTaskSnapshot;
  controller: AbortController;
  done: Promise<BackgroundTaskSnapshot>;
}

export class BackgroundTaskCancelledError
  extends Error {
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

function cloneTaskSnapshot(
  snapshot:
    BackgroundTaskSnapshot,
): BackgroundTaskSnapshot {
  return {
    ...snapshot,
  };
}

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

  public countRunning():
    number {
    return this.list(
      false,
    ).length;
  }

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
