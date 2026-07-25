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

export interface SubAgentDefinition {
  name: string;
  description: string;
  systemPrompt: string;
  model?: string;
}

export interface SubAgentTask {
  task: string;
  context?: string;
}

export type AgentRuntimeConfig =
  Pick<
    AppConfig,
    | "apiUrl"
    | "apiKey"
    | "defaultModel"
  >;

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

export interface SubAgentWorkerSuccess {
  type: "result";
  requestId: string;
  success: true;
  output: string;
  model: string;
  workerPid: number;
}

export interface SubAgentWorkerFailure {
  type: "result";
  requestId: string;
  success: false;
  error: string;
  model?: string;
  workerPid: number;
}

export type SubAgentWorkerResponse =
  | SubAgentWorkerSuccess
  | SubAgentWorkerFailure;

export interface SubAgentResult {
  requestId: string;
  agentName: string;
  output: string;
  model: string;
  workerPid: number;
}

export interface RunSubAgentOptions {
  hookRegistry?: HookRegistry;
  timeoutMs?: number;
  workerPath?: string;
}

const DEFAULT_TIMEOUT_MS =
  120_000;

const defaultWorkerPath =
  fileURLToPath(
    new URL(
      "./agent-worker.js",
      import.meta.url,
    ),
  );

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

function formatError(
  error: unknown,
): string {
  return error instanceof
    Error
    ? error.message
    : String(error);
}

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

      function handleError(
        error: Error,
      ): void {
        void rejectTask(
          new Error(
            `Unable to run sub-agent "${definition.name}": ${error.message}`,
          ),
        );
      }

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


export interface ActiveSubAgentDefinition
  extends SubAgentDefinition {
  pluginName: string;
  pluginDirectory: string;
  source: LoadedPlugin["source"];
}

const SUB_AGENT_NAME_PATTERN =
  /^[a-z0-9][a-z0-9_-]*$/;

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
