/**
 * Sub-agent definition, worker-process orchestration, and plugin-agent support
 * for Sky Code.
 *
 * Delegated tasks run in a forked Node.js worker so their model request is
 * isolated from the main CLI process. This module validates agent/task/runtime
 * input, coordinates IPC, enforces a timeout, emits lifecycle notifications,
 * and converts worker replies into SubAgentResult values.
 *
 * It also validates sub-agents contributed by plugins, prevents duplicate agent
 * names, and formats the active agent catalog for the model-facing prompt.
 */
import {
  fork,
  type ChildProcess,
} from "node:child_process";

import {
  randomUUID,
} from "node:crypto";

import {
  fileURLToPath,
} from "node:url";

import type {
  AppConfig,
} from "./config.js";

import type {
  HookRegistry,
  NotificationLevel,
} from "./hooks.js";

import type {
  LoadedPlugin,
} from "./plugins.js";

/**
 * Configuration describing one sub-agent that can receive delegated work.
 *
 * model is optional; when omitted, the current Sky Code default model is used.
 */
export interface SubAgentDefinition {
  name: string;
  description: string;
  systemPrompt: string;
  model?: string;
}

/**
 * Task delegated to a sub-agent.
 *
 * context is optional supplemental information kept separate from the primary
 * task instruction.
 */
export interface SubAgentTask {
  task: string;
  context?: string;
}

/**
 * Minimal application configuration required by a sub-agent worker.
 *
 * Only API connection details and the default model are passed to the child
 * process rather than the complete AppConfig object.
 */
export type AgentRuntimeConfig =
  Pick<
    AppConfig,
    | "apiUrl"
    | "apiKey"
    | "defaultModel"
  >;

/**
 * IPC request sent from the main Sky Code process to a sub-agent worker.
 *
 * requestId correlates the worker response with this specific invocation.
 */
export interface SubAgentWorkerRequest {
  type: "run";
  requestId: string;

  agent: {
    name: string;
    description: string;
    systemPrompt: string;
    model?: string;
  };

  task: string;
  context?: string;

  config: AgentRuntimeConfig;
}

/**
 * Successful IPC response returned by a sub-agent worker.
 */
export interface SubAgentWorkerSuccess {
  type: "result";
  requestId: string;
  success: true;
  output: string;
  model: string;
  workerPid: number;
}

/**
 * Failed IPC response returned by a sub-agent worker.
 *
 * model is optional because a failure can occur before the worker resolves
 * which model it will use.
 */
export interface SubAgentWorkerFailure {
  type: "result";
  requestId: string;
  success: false;
  error: string;
  model?: string;
  workerPid: number;
}

/**
 * Union of all result messages a sub-agent worker may send to its parent.
 */
export type SubAgentWorkerResponse =
  | SubAgentWorkerSuccess
  | SubAgentWorkerFailure;

/**
 * Successful public result returned by runSubAgentTask().
 *
 * workerPid is retained for diagnostics and requestId identifies the delegated
 * invocation that produced the output.
 */
export interface SubAgentResult {
  requestId: string;
  agentName: string;
  output: string;
  model: string;
  workerPid: number;
}

/**
 * Optional controls for one sub-agent invocation.
 *
 * hookRegistry enables lifecycle notifications, timeoutMs overrides the default
 * worker timeout, and workerPath allows tests or alternate runtimes to provide
 * a different worker module.
 */
export interface RunSubAgentOptions {
  hookRegistry?: HookRegistry;
  timeoutMs?: number;
  workerPath?: string;
}

/**
 * Default maximum duration for one delegated sub-agent task: two minutes.
 */
const DEFAULT_TIMEOUT_MS =
  120_000;

/**
 * Filesystem path of the compiled worker module located beside this module.
 *
 * import.meta.url keeps resolution relative to the installed Sky Code runtime
 * instead of the caller's current working directory.
 */
const defaultWorkerPath =
  fileURLToPath(
    new URL(
      "./agent-worker.js",
      import.meta.url,
    ),
  );

/**
 * Validates and trims a required text value.
 *
 * @param {unknown} value - Runtime value to validate.
 * @param {string} fieldName - Human-readable field label used in errors.
 * @returns {string} Trimmed non-empty string.
 * @throws {Error} If value is not a string or is empty after trimming.
 */
function requireNonEmptyString(
  value: unknown,
  fieldName: string,
): string {
  if (
    typeof value !==
      "string" ||
    value.trim() ===
      ""
  ) {
    throw new Error(
      `${fieldName} must be a non-empty string`,
    );
  }

  return value.trim();
}

/**
 * Validates and normalizes a sub-agent definition.
 *
 * Required text fields are trimmed. An optional model is validated when
 * present and omitted from the returned object when undefined.
 *
 * @param {SubAgentDefinition} definition - Candidate agent definition.
 * @returns {SubAgentDefinition} Normalized validated definition.
 * @throws {Error} If any required field or optional model is invalid.
 */
function validateDefinition(
  definition: SubAgentDefinition,
): SubAgentDefinition {
  const name =
    requireNonEmptyString(
      definition.name,
      "Sub-agent name",
    );

  const description =
    requireNonEmptyString(
      definition.description,
      "Sub-agent description",
    );

  const systemPrompt =
    requireNonEmptyString(
      definition.systemPrompt,
      "Sub-agent system prompt",
    );

  const model =
    definition.model ===
      undefined
      ? undefined
      : requireNonEmptyString(
          definition.model,
          "Sub-agent model",
        );

  return {
    name,
    description,
    systemPrompt,
    ...(model === undefined
      ? {}
      : {
          model,
        }),
  };
}

/**
 * Validates and normalizes a delegated sub-agent task.
 *
 * The main task text must be non-empty. Optional context may be an empty string
 * but, when provided, must still be a string.
 *
 * @param {SubAgentTask} task - Candidate delegated task.
 * @returns {SubAgentTask} Normalized validated task.
 * @throws {Error} If task text is empty or context is not a string.
 */
function validateTask(
  task: SubAgentTask,
): SubAgentTask {
  const taskText =
    requireNonEmptyString(
      task.task,
      "Delegated task",
    );

  if (
    task.context !==
      undefined &&
    typeof task.context !==
      "string"
  ) {
    throw new Error(
      "Delegated context must be a string",
    );
  }

  return {
    task:
      taskText,
    ...(task.context ===
      undefined
      ? {}
      : {
          context:
            task.context,
        }),
  };
}

/**
 * Validates the runtime configuration passed to the worker process.
 *
 * @param {AgentRuntimeConfig} config - Candidate API/model configuration.
 * @returns {AgentRuntimeConfig} Trimmed validated runtime configuration.
 * @throws {Error} If the API URL, API key, or default model is empty.
 */
function validateRuntimeConfig(
  config: AgentRuntimeConfig,
): AgentRuntimeConfig {
  return {
    apiUrl:
      requireNonEmptyString(
        config.apiUrl,
        "Sub-agent API URL",
      ),
    apiKey:
      requireNonEmptyString(
        config.apiKey,
        "Sub-agent API key",
      ),
    defaultModel:
      requireNonEmptyString(
        config.defaultModel,
        "Sub-agent default model",
      ),
  };
}

/**
 * Resolves and validates the worker timeout.
 *
 * Undefined uses DEFAULT_TIMEOUT_MS. Explicit values must be positive integers.
 *
 * @param {number | undefined} timeoutMs - Optional timeout override in
 * milliseconds.
 * @returns {number} Valid positive timeout in milliseconds.
 * @throws {Error} If the resolved timeout is not a positive integer.
 */
function validateTimeout(
  timeoutMs: number | undefined,
): number {
  const resolvedTimeout =
    timeoutMs ??
    DEFAULT_TIMEOUT_MS;

  if (
    !Number.isInteger(
      resolvedTimeout,
    ) ||
    resolvedTimeout < 1
  ) {
    throw new Error(
      "Sub-agent timeout must be a positive integer",
    );
  }

  return resolvedTimeout;
}

/**
 * Checks whether an unknown IPC message is a non-null, non-array object.
 *
 * @param {unknown} value - Runtime value to inspect.
 * @returns {boolean} True when value can be treated as an object record.
 */
function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value ===
      "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

/**
 * Formats child-process exit information for a diagnostic message.
 *
 * Signal termination takes precedence over a numeric exit code. When neither is
 * available, a generic unknown-status description is returned.
 *
 * @param {number | null} code - Child-process exit code, when available.
 * @param {NodeJS.Signals | null} signal - Terminating signal, when available.
 * @returns {string} Human-readable exit description.
 */
function describeExit(
  code: number | null,
  signal: NodeJS.Signals | null,
): string {
  if (signal !== null) {
    return `signal ${signal}`;
  }

  if (code !== null) {
    return `exit code ${code}`;
  }

  return "an unknown exit status";
}

/**
 * Converts an unknown thrown value into readable error text.
 *
 * @param {unknown} error - Thrown or rejected value.
 * @returns {string} Error.message for Error instances, otherwise String(error).
 */
function formatError(
  error: unknown,
): string {
  return error instanceof
    Error
    ? error.message
    : String(error);
}

/**
 * Emits a Notification hook event when a hook registry is available.
 *
 * With no registry this function is a no-op, allowing sub-agent execution to be
 * used without hooks.
 *
 * @param {HookRegistry | undefined} registry - Optional lifecycle hook registry.
 * @param {NotificationLevel} level - Notification severity.
 * @param {string} message - Human-readable notification text.
 * @param {Record<string, unknown>} metadata - Structured event metadata.
 * @returns {Promise<void>} Resolves after notification handlers finish, or
 * immediately when no registry is supplied.
 * @throws {Error} If a Notification hook handler fails.
 *
 * Side effect: may execute registered Notification hooks.
 */
async function emitNotification(
  registry: HookRegistry | undefined,
  level: NotificationLevel,
  message: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  if (!registry) {
    return;
  }

  await registry.run(
    "Notification",
    {
      level,
      message,
      metadata,
    },
  );
}

/**
 * Best-effort synchronous shutdown request for a forked sub-agent worker.
 *
 * The IPC channel is disconnected first when still connected, then the child is
 * killed when it has not already been killed.
 *
 * @param {ChildProcess} child - Worker process to stop.
 * @returns {void}
 *
 * Side effects: may disconnect IPC and send a termination signal to the child.
 */
function stopWorker(
  child: ChildProcess,
): void {
  if (child.connected) {
    child.disconnect();
  }

  if (!child.killed) {
    child.kill();
  }
}

/**
 * Runs one delegated task in a forked sub-agent worker process.
 *
 * Inputs are validated before the worker starts. A unique request ID correlates
 * IPC traffic, and the agent-specific model overrides the Sky Code default when
 * provided. The worker is given a two-way IPC channel while its standard
 * input/output/error streams are ignored.
 *
 * Exactly one terminal outcome settles the returned promise. Success, worker
 * failure, malformed IPC, process errors, premature exit, send failure, and
 * timeout all remove listeners and stop the worker. Optional Notification hooks
 * receive started, completed, or failed lifecycle events.
 *
 * @param {SubAgentDefinition} definitionValue - Agent definition to run.
 * @param {SubAgentTask} taskValue - Task and optional context to delegate.
 * @param {AgentRuntimeConfig} configValue - API/model configuration for the
 * worker.
 * @param {RunSubAgentOptions} options - Optional hooks, timeout, and worker path.
 * @returns {Promise<SubAgentResult>} Successful sub-agent output and execution
 * metadata.
 * @throws {Error} If validation fails, a lifecycle Notification hook fails, the
 * worker cannot run or respond correctly, reports failure, exits early, or
 * exceeds its timeout.
 *
 * Side effects: emits optional hooks, forks a child process, exchanges IPC
 * messages, starts a timer, and terminates the worker when the task settles.
 */
export async function runSubAgentTask(
  definitionValue:
    SubAgentDefinition,
  taskValue:
    SubAgentTask,
  configValue:
    AgentRuntimeConfig,
  options:
    RunSubAgentOptions = {},
): Promise<SubAgentResult> {
  const definition =
    validateDefinition(
      definitionValue,
    );

  const task =
    validateTask(
      taskValue,
    );

  const config =
    validateRuntimeConfig(
      configValue,
    );

  const timeoutMs =
    validateTimeout(
      options.timeoutMs,
    );

  const workerPath =
    options.workerPath ??
    defaultWorkerPath;

  const requestId =
    randomUUID();

  const model =
    definition.model ??
    config.defaultModel;

  await emitNotification(
    options.hookRegistry,
    "info",
    `Sub-agent "${definition.name}" started.`,
    {
      event:
        "sub_agent_started",
      requestId,
      agentName:
        definition.name,
      model,
    },
  );

  const request:
    SubAgentWorkerRequest = {
      type:
        "run",
      requestId,
      agent: {
        name:
          definition.name,
        description:
          definition.description,
        systemPrompt:
          definition.systemPrompt,
        ...(definition.model ===
          undefined
          ? {}
          : {
              model:
                definition.model,
            }),
      },
      task:
        task.task,
      ...(task.context ===
        undefined
        ? {}
        : {
            context:
              task.context,
          }),
      config,
    };

  // Start a dedicated worker with only IPC enabled; delegated output is returned
  // through structured messages rather than inherited terminal streams.
  const child =
    fork(
      workerPath,
      [],
      {
        stdio: [
          "ignore",
          "ignore",
          "ignore",
          "ipc",
        ],
        // Do not inherit parent Node execution flags such as loaders or test-runner
        // arguments into the worker process.
        execArgv: [],
      },
    );

  return new Promise<
    SubAgentResult
  >(
    (
      resolve,
      reject,
    ) => {
      let settled = false;

      let timeout:
        NodeJS.Timeout;

      /**
       * Detaches worker listeners and clears the timeout for this invocation.
       *
       * @returns {void}
       *
       * Side effect: removes event listeners and cancels the active timer.
       */
      const removeListeners =
        (): void => {
          child.off(
            "message",
            handleMessage,
          );

          child.off(
            "error",
            handleError,
          );

          child.off(
            "exit",
            handleExit,
          );

          clearTimeout(
            timeout,
          );
        };

      /**
       * Settles this invocation as a failure exactly once.
       *
       * Cleanup and worker shutdown happen before the failure notification. If
       * that notification also fails, both failures are preserved in the
       * rejection message.
       *
       * @param {Error} error - Primary sub-agent failure.
       * @returns {Promise<void>} Resolves after rejecting the outer promise.
       *
       * Side effects: removes listeners, stops the worker, may emit a failure
       * Notification hook, and rejects the outer promise.
       */
      const rejectTask =
        async (
          error: Error,
        ): Promise<void> => {
          if (settled) {
            return;
          }

          settled = true;

          removeListeners();
          stopWorker(child);

          try {
            await emitNotification(
              options.hookRegistry,
              "error",
              `Sub-agent "${definition.name}" failed: ${error.message}`,
              {
                event:
                  "sub_agent_failed",
                requestId,
                agentName:
                  definition.name,
                model,
                error:
                  error.message,
              },
            );
          } catch (
            notificationError
          ) {
            reject(
              new Error(
                `${error.message}; Notification hook failed: ${formatError(notificationError)}`,
              ),
            );

            return;
          }

          reject(error);
        };

      /**
       * Settles this invocation successfully exactly once.
       *
       * The worker is cleaned up before the completion notification is emitted.
       * A completion-hook failure rejects the outer promise instead of returning
       * an otherwise successful result.
       *
       * @param {SubAgentWorkerSuccess} response - Validated successful worker
       * response.
       * @returns {Promise<void>} Resolves after settling the outer promise.
       *
       * Side effects: removes listeners, stops the worker, may emit a completion
       * Notification hook, and resolves or rejects the outer promise.
       */
      const resolveTask =
        async (
          response:
            SubAgentWorkerSuccess,
        ): Promise<void> => {
          if (settled) {
            return;
          }

          settled = true;

          removeListeners();
          stopWorker(child);

          const result:
            SubAgentResult = {
            requestId,
            agentName:
              definition.name,
            output:
              response.output,
            model:
              response.model,
            workerPid:
              response.workerPid,
          };

          try {
            await emitNotification(
              options.hookRegistry,
              "info",
              `Sub-agent "${definition.name}" completed.`,
              {
                event:
                  "sub_agent_completed",
                requestId,
                agentName:
                  definition.name,
                model:
                  response.model,
                workerPid:
                  response.workerPid,
              },
            );
          } catch (
            notificationError
          ) {
            reject(
              notificationError,
            );

            return;
          }

          resolve(result);
        };

      /**
       * Validates and handles one IPC message from the worker.
       *
       * Messages with another type or requestId are ignored. Matching result
       * messages must contain an integer worker PID and the fields required by
       * their success/failure variant.
       *
       * @param {unknown} message - IPC payload received from the child process.
       * @returns {void}
       *
       * Side effect: may asynchronously settle the delegated task.
       */
      function handleMessage(
        message: unknown,
      ): void {
        if (
          !isRecord(message) ||
          message.type !==
            "result" ||
          message.requestId !==
            requestId
        ) {
          return;
        }

        const workerPid =
          message.workerPid;

        if (
          !Number.isInteger(
            workerPid,
          )
        ) {
          void rejectTask(
            new Error(
              `Sub-agent "${definition.name}" returned an invalid worker PID.`,
            ),
          );

          return;
        }

        if (
          message.success ===
            true
        ) {
          if (
            typeof message.output !==
              "string" ||
            typeof message.model !==
              "string" ||
            message.model.trim() ===
              ""
          ) {
            void rejectTask(
              new Error(
                `Sub-agent "${definition.name}" returned an invalid success response.`,
              ),
            );

            return;
          }

          void resolveTask({
            type:
              "result",
            requestId,
            success:
              true,
            output:
              message.output,
            model:
              message.model,
            workerPid:
              workerPid as number,
          });

          return;
        }

        if (
          message.success ===
            false &&
          typeof message.error ===
            "string"
        ) {
          void rejectTask(
            new Error(
              `Sub-agent "${definition.name}" failed: ${message.error}`,
            ),
          );

          return;
        }

        void rejectTask(
          new Error(
            `Sub-agent "${definition.name}" returned an invalid response.`,
          ),
        );
      }

      /**
       * Handles a child-process runtime error.
       *
       * @param {Error} error - Error emitted by the worker ChildProcess.
       * @returns {void}
       *
       * Side effect: asynchronously rejects the delegated task.
       */
      function handleError(
        error: Error,
      ): void {
        void rejectTask(
          new Error(
            `Unable to run sub-agent "${definition.name}": ${error.message}`,
          ),
        );
      }

      /**
       * Handles a worker that exits before returning a valid result.
       *
       * Exit events after the invocation has already settled are ignored.
       *
       * @param {number | null} code - Process exit code, when available.
       * @param {NodeJS.Signals | null} signal - Terminating signal, when present.
       * @returns {void}
       *
       * Side effect: may asynchronously reject the delegated task.
       */
      function handleExit(
        code: number | null,
        signal:
          NodeJS.Signals | null,
      ): void {
        if (settled) {
          return;
        }

        void rejectTask(
          new Error(
            `Sub-agent "${definition.name}" exited before returning a result with ${describeExit(code, signal)}.`,
          ),
        );
      }

      child.on(
        "message",
        handleMessage,
      );

      child.once(
        "error",
        handleError,
      );

      child.once(
        "exit",
        handleExit,
      );

      // The timeout uses the same rejectTask path as all other failures so cleanup
      // and failure notifications remain consistent.
      timeout =
        setTimeout(
          () => {
            void rejectTask(
              new Error(
                `Sub-agent "${definition.name}" timed out after ${timeoutMs} ms.`,
              ),
            );
          },
          timeoutMs,
        );

      // Send only after listeners and the timeout are installed so very fast worker
      // responses or send failures cannot race past the settlement handlers.
      child.send(
        request,
        (
          error,
        ) => {
          if (error) {
            void rejectTask(
              new Error(
                `Unable to send task to sub-agent "${definition.name}": ${error.message}`,
              ),
            );
          }
        },
      );
    },
  );
}


/**
 * Plugin-provided sub-agent enriched with its owning plugin metadata.
 */
export interface ActiveSubAgentDefinition
  extends SubAgentDefinition {
  pluginName: string;
  pluginDirectory: string;
  source: LoadedPlugin["source"];
}

/**
 * Allowed syntax for plugin sub-agent names.
 *
 * Names use lowercase letters, digits, hyphens, and underscores and must begin
 * with a letter or digit.
 */
const SUB_AGENT_NAME_PATTERN =
  /^[a-z0-9][a-z0-9_-]*$/;

/**
 * Checks whether a raw plugin agent entry is a non-null, non-array object.
 *
 * @param {unknown} value - Manifest value to inspect.
 * @returns {boolean} True when the value can be treated as an object record.
 */
function isPluginAgentRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value ===
      "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

/**
 * Validates one raw plugin `agents[index]` manifest entry.
 *
 * Required fields are normalized with the shared sub-agent string validator.
 * Plugin agent names additionally follow SUB_AGENT_NAME_PATTERN. The returned
 * definition is enriched with the owning plugin name, directory, and source.
 *
 * @param {LoadedPlugin} plugin - Plugin declaring the agent.
 * @param {unknown} entry - Raw agents[index] manifest value.
 * @param {number} index - Zero-based agent index used in diagnostics.
 * @returns {ActiveSubAgentDefinition} Validated plugin sub-agent definition.
 * @throws {Error} If the entry is not an object or any agent field is invalid.
 */
function parsePluginAgentDefinition(
  plugin: LoadedPlugin,
  entry: unknown,
  index: number,
): ActiveSubAgentDefinition {
  const fieldName =
    `agents[${index}]`;

  if (
    !isPluginAgentRecord(
      entry,
    )
  ) {
    throw new Error(
      `Plugin manifest ${plugin.manifestPath}: ${fieldName} must be a JSON object`,
    );
  }

  const name =
    requireNonEmptyString(
      entry.name,
      `Plugin manifest ${plugin.manifestPath}: ${fieldName}.name`,
    );

  if (
    !SUB_AGENT_NAME_PATTERN.test(
      name,
    )
  ) {
    throw new Error(
      `Plugin manifest ${plugin.manifestPath}: ${fieldName}.name may contain only lowercase letters, digits, hyphens, and underscores, and must begin with a letter or digit`,
    );
  }

  const description =
    requireNonEmptyString(
      entry.description,
      `Plugin manifest ${plugin.manifestPath}: ${fieldName}.description`,
    );

  const systemPrompt =
    requireNonEmptyString(
      entry.systemPrompt,
      `Plugin manifest ${plugin.manifestPath}: ${fieldName}.systemPrompt`,
    );

  const model =
    entry.model ===
      undefined
      ? undefined
      : requireNonEmptyString(
          entry.model,
          `Plugin manifest ${plugin.manifestPath}: ${fieldName}.model`,
        );

  return {
    name,
    description,
    systemPrompt,
    ...(model ===
      undefined
      ? {}
      : {
          model,
        }),
    pluginName:
      plugin.name,
    pluginDirectory:
      plugin.directory,
    source:
      plugin.source,
  };
}

/**
 * Validates and merges all plugin-provided sub-agents.
 *
 * Agent names form one global namespace across active plugins. Duplicate names
 * are rejected with both plugin origins identified. The final catalog is sorted
 * by agent name for deterministic prompt output.
 *
 * @param {readonly LoadedPlugin[]} plugins - Loaded plugins contributing agents.
 * @returns {ActiveSubAgentDefinition[]} Validated active agents sorted by name.
 * @throws {Error} If an agent definition is invalid or two plugins use the same
 * sub-agent name.
 */
export function mergePluginAgents(
  plugins:
    readonly LoadedPlugin[],
): ActiveSubAgentDefinition[] {
  const agents:
    ActiveSubAgentDefinition[] = [];

  const agentOrigins =
    new Map<
      string,
      string
    >();

  for (
    const plugin of plugins
  ) {
    for (
      let index = 0;
      index <
      plugin.agents.length;
      index += 1
    ) {
      const agent =
        parsePluginAgentDefinition(
          plugin,
          plugin.agents[index],
          index,
        );

      const existingPlugin =
        agentOrigins.get(
          agent.name,
        );

      if (
        existingPlugin !==
          undefined
      ) {
        throw new Error(
          `Duplicate sub-agent name "${agent.name}" in plugins "${existingPlugin}" and "${plugin.name}"`,
        );
      }

      agentOrigins.set(
        agent.name,
        plugin.name,
      );

      agents.push(
        agent,
      );
    }
  }

  return agents.sort(
    (
      left,
      right,
    ) =>
      left.name.localeCompare(
        right.name,
      ),
  );
}

/**
 * Formats active sub-agents for inclusion in the model-facing prompt.
 *
 * With no agents, the prompt explicitly states that none are active. Otherwise
 * each line identifies the agent, owning plugin, description, and whether it
 * uses a fixed model or the current Sky Code model.
 *
 * @param {readonly ActiveSubAgentDefinition[]} agents - Active plugin agents.
 * @returns {string[]} Prompt lines describing the available sub-agents.
 */
export function formatSubAgentsForPrompt(
  agents:
    readonly ActiveSubAgentDefinition[],
): string[] {
  if (
    agents.length === 0
  ) {
    return [
      "",
      "No sub-agents are active in this session.",
    ];
  }

  const lines = [
    "",
    "Active sub-agents:",
  ];

  for (
    const agent of agents
  ) {
    const modelDescription =
      agent.model ===
        undefined
        ? "uses the current Sky Code model"
        : `uses model "${agent.model}"`;

    lines.push(
      `- "${agent.name}" from plugin "${agent.pluginName}": ${agent.description} (${modelDescription})`,
    );
  }

  return lines;
}
