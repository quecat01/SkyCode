#!/usr/bin/env node

import {
  existsSync,
  realpathSync,
} from "node:fs";

import {
  homedir,
} from "node:os";

import {
  resolve,
} from "node:path";

import {
  stdin as input,
  stdout as output,
} from "node:process";

import {
  createInterface,
  type Interface as ReadlineInterface,
} from "node:readline/promises";

import {
  fileURLToPath,
} from "node:url";

import {
  mergePluginAgents,
} from "./agents.js";

import {
  BackgroundTaskRegistry,
} from "./background.js";

import {
  createBackgroundTerminalReporter,
} from "./background-terminal.js";

import {
  createBackgroundSessionReporter,
} from "./background-session.js";

import {
  executeBackgroundTasksCommand,
  parseBackgroundTasksCommand,
} from "./background-commands.js";

import {
  shouldReturnToPromptAfterBackgroundTool,
} from "./background-turn.js";

import {
  fetchAvailableModels,
  streamChatCompletion,
  type ChatMessage,
} from "./chat.js";

import {
  executeCatalogShellCommand,
  resolveCatalogCommand,
  selectEnabledCatalogSkills,
  validateCatalogPluginConflicts,
} from "./catalog-runtime.js";

import {
  CatalogManager,
  parseCatalogManagementCommand,
} from "./catalog-management.js";

import {
  loadCatalog,
} from "./catalog.js";

import {
  formatContextCompactionResult,
  runAutomaticContextCompaction,
  runContextCompaction,
} from "./compact-runtime.js";

import {
  loadConfig,
  type AppConfig,
} from "./config.js";

import {
  formatCliErrorReport,
} from "./error-reporting.js";

import {
  executeSkyToolRequestWithHooks,
  HookRegistry,
  registerPluginHooks,
} from "./hooks.js";

import {
  formatHistorySearchResults,
  parseHistoryCommand,
  searchSessionHistory,
} from "./history.js";

import {
  closeMcpConnections,
  connectConfiguredMcpServers,
  type McpConnection,
  type McpToolDefinition,
} from "./mcp.js";

import {
  loadPlugins,
  mergePluginMcpServers,
  mergePluginSkills,
  resolvePluginSkillCommand,
} from "./plugins.js";

import {
  formatPermissionModeChoices,
  parsePermissionModeSelection,
  PermissionController,
} from "./permissions.js";

import {
  redrawReadlinePrompt,
  restoreReadlineRawMode,
} from "./readline-redraw.js";

import {
  createSessionLogger,
  type SessionLogger,
} from "./session.js";

import {
  findLatestResumableSession,
  type ResumableSession,
} from "./session-resume.js";

import {
  promptForSessionResume,
} from "./session-resume-prompt.js";

import {
  runSetup,
} from "./setup.js";

import {
  runStartupHealthCheck,
} from "./startup-health.js";

import {
  createSkyCodeToolHandlers,
} from "./toolhandlers.js";

import {
  createSkyCodeSystemPrompt,
  parseSkyToolRequest,
  type SkyToolRequest,
  type ToolExecutionResult,
  type ToolHandlers,
} from "./tools.js";

import {
  formatError,
} from "./utils.js";

const MAX_TOOL_ROUNDS = 20;

function printCliError(
  error:
    unknown,

  operation:
    string,
): void {
  for (
    const line of
    formatCliErrorReport(
      error,
      {
        operation,
      },
    )
  ) {
    console.error(
      line,
    );
  }
}

interface StreamedTurn {
  responseText: string;
  displayedText: boolean;
}

function createToolResultMessage(
  request: SkyToolRequest,
  result: ToolExecutionResult,
): string {
  return [
    `Sky Code tool result for ${request.tool}:`,
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
  ].join("\n");
}

async function streamModelTurn(
  config: AppConfig,
  activeModel: string,
  messages: ChatMessage[],
  systemPrompt: string,
): Promise<StreamedTurn> {
  let responseText = "";
  let pendingText = "";

  let displayMode:
    | "undetermined"
    | "normal"
    | "tool" =
    "undetermined";

  let displayedText = false;

  const response =
    await streamChatCompletion(
      config,
      activeModel,
      messages,
      (content) => {
        responseText += content;

        if (
          displayMode ===
          "normal"
        ) {
          output.write(
            content,
          );

          displayedText = true;
          return;
        }

        pendingText += content;

        const trimmedStart =
          pendingText.trimStart();

        if (
          "```sky-tool".startsWith(
            trimmedStart,
          )
        ) {
          return;
        }

        if (
          trimmedStart.startsWith(
            "```sky-tool",
          )
        ) {
          displayMode = "tool";
          return;
        }

        displayMode = "normal";

        output.write(
          pendingText,
        );

        displayedText = true;
        pendingText = "";
      },
      systemPrompt,
    );

  if (
    displayMode ===
    "undetermined"
  ) {
    const trimmedStart =
      pendingText.trimStart();

    if (
      trimmedStart.startsWith(
        "```sky-tool",
      )
    ) {
      displayMode = "tool";
    } else {
      displayMode = "normal";

      if (
        pendingText !== ""
      ) {
        output.write(
          pendingText,
        );

        displayedText = true;
      }
    }
  }

  return {
    responseText:
      response,
    displayedText,
  };
}

async function selectModel(
  config: AppConfig,
  readline: ReadlineInterface,
  currentModel: string,
): Promise<string> {
  let models: string[];

  try {
    models =
      await fetchAvailableModels(
        config,
      );
  } catch (error) {
    printCliError(
      error,
      "Model list retrieval",
    );

    console.log(
      `Continuing with current model: ${currentModel}`,
    );

    return currentModel;
  }

  if (
    models.length === 0
  ) {
    console.error(
      "LiteLLM returned an empty model list.",
    );

    console.log(
      `Continuing with current model: ${currentModel}`,
    );

    return currentModel;
  }

  console.log();
  console.log(
    "Available models:",
  );

  models.forEach(
    (
      model,
      index,
    ) => {
      const activeMarker =
        model === currentModel
          ? " (current)"
          : "";

      console.log(
        `${index + 1}. ${model}${activeMarker}`,
      );
    },
  );

  console.log();

  const answer = (
    await readline.question(
      "Enter the model number, or press Enter to keep the current model: ",
    )
  ).trim();

  if (answer === "") {
    console.log(
      `Current model unchanged: ${currentModel}`,
    );

    return currentModel;
  }

  if (
    !/^[0-9]+$/.test(
      answer,
    )
  ) {
    console.error(
      "Invalid selection. Enter a model number from the displayed list.",
    );

    return currentModel;
  }

  const selectedIndex =
    Number(answer) - 1;

  const selectedModel =
    models[selectedIndex];

  if (!selectedModel) {
    console.error(
      "Invalid selection. The model number is outside the displayed range.",
    );

    return currentModel;
  }

  console.log(
    `Active model: ${selectedModel}`,
  );

  return selectedModel;
}

async function selectPermissionMode(
  readline:
    ReadlineInterface,
  controller:
    PermissionController,
): Promise<void> {
  const currentMode =
    controller.getMode();

  console.log();
  console.log(
    `Current permission mode: ${currentMode}`,
  );

  console.log();
  console.log(
    "Available permission modes:",
  );

  for (
    const line of
    formatPermissionModeChoices(
      currentMode,
    )
  ) {
    console.log(
      line,
    );
  }

  console.log();

  const answer = (
    await readline.question(
      "Enter the permission mode number, or press Enter to keep the current mode: ",
    )
  ).trim();

  if (
    answer ===
      ""
  ) {
    console.log(
      `Permission mode unchanged: ${currentMode}`,
    );

    return;
  }

  const selectedMode =
    parsePermissionModeSelection(
      answer,
    );

  if (!selectedMode) {
    console.error(
      "Invalid selection. Enter a permission mode number from 1 to 4.",
    );

    console.log(
      `Permission mode remains: ${currentMode}`,
    );

    return;
  }

  controller.setMode(
    selectedMode,
  );

  console.log(
    `Active permission mode: ${selectedMode}`,
  );

  if (
    selectedMode ===
      "bypass"
  ) {
    console.log(
      "WARNING: Bypass mode executes all tools without approval prompts.",
    );
  }
}

async function compactCurrentContext(
  config:
    AppConfig,
  activeModel:
    string,
  messages:
    ChatMessage[],
  hookRegistry:
    HookRegistry,
  sessionLogger:
    SessionLogger,
): Promise<void> {
  console.log();

  console.log(
    "Compacting conversation context...",
  );

  const result =
    await runContextCompaction({
      config,
      model:
        activeModel,
      messages,
      reason:
        "manual",
      hookRegistry,
      sessionLogger,
    });

  for (
    const line of
    formatContextCompactionResult(
      result,
    )
  ) {
    console.log(
      line,
    );
  }

  console.log();
}

async function completeConversationTurn(
  config: AppConfig,
  activeModel: string,
  messages: ChatMessage[],
  readline: ReadlineInterface,
  sessionLogger: SessionLogger,
  handlers: ToolHandlers,
  hookRegistry: HookRegistry,
  systemPrompt: string,
): Promise<void> {
  for (
    let toolRound = 0;
    toolRound <
    MAX_TOOL_ROUNDS;
    toolRound += 1
  ) {
    const streamedTurn =
      await streamModelTurn(
        config,
        activeModel,
        messages,
        systemPrompt,
      );

    const assistantResponse =
      streamedTurn.responseText;

    await sessionLogger.append({
      type: "message",
      role: "assistant",
      content:
        assistantResponse,
      model:
        activeModel,
    });

    const toolRequest =
      parseSkyToolRequest(
        assistantResponse,
      );

    messages.push({
      role: "assistant",
      content:
        assistantResponse,
    });

    if (!toolRequest) {
      if (
        streamedTurn.displayedText
      ) {
        output.write(
          "\n\n",
        );
      } else {
        output.write(
          "(The model returned an empty response.)\n\n",
        );
      }

      return;
    }

    readline.pause();

    let toolResult:
      ToolExecutionResult;

    try {
      toolResult =
        await executeSkyToolRequestWithHooks(
          toolRequest,
          handlers,
          hookRegistry,
        );
    } finally {
      readline.resume();

      restoreReadlineRawMode(
        input,
      );
    }

    console.log(
      toolResult.success
        ? `Tool completed: ${toolRequest.tool}`
        : `Tool failed: ${toolRequest.tool}`,
    );

    if (
      !toolResult.success
    ) {
      console.log(
        toolResult.output,
      );
    }

    await sessionLogger.append({
      type: "tool_result",
      role: "tool",
      content:
        toolResult.output,
      model:
        activeModel,
      tool:
        toolRequest.tool,
      success:
        toolResult.success,
    });

    if (
      shouldReturnToPromptAfterBackgroundTool(
        toolRequest,
        toolResult,
      )
    ) {
      console.log(
        toolResult.output,
      );

      console.log();
      return;
    }

    messages.push({
      role: "user",
      content:
        createToolResultMessage(
          toolRequest,
          toolResult,
        ),
    });
  }

  throw new Error(
    `Sky Code stopped after ${MAX_TOOL_ROUNDS} consecutive tool requests.`,
  );
}

async function loadMcpTools(
  connections:
    readonly McpConnection[],
): Promise<McpToolDefinition[]> {
  const tools:
    McpToolDefinition[] = [];

  for (
    const connection of
    connections
  ) {
    try {
      tools.push(
        ...await connection.listTools(),
      );
    } catch (error) {
      throw new Error(
        `Unable to retrieve tools from MCP server "${connection.serverName}": ${formatError(error)}`,
      );
    }
  }

  return tools;
}

export async function runCli():
  Promise<void> {
  if (
    process.argv[2] ===
    "setup"
  ) {
    await runSetup();
    process.exit(0);
  }

  const workingDirectory =
    process.cwd();

  const globalConfigPath =
    resolve(
      homedir(),
      ".sky-code",
      "config.json",
    );

  const projectEnvironmentPath =
    fileURLToPath(
      new URL(
        "../.env",
        import.meta.url,
      ),
    );

  const hasEnvironmentApiUrl =
    typeof process.env
      .LITELLM_API_URL ===
      "string" &&
    process.env
      .LITELLM_API_URL
      .trim() !==
      "";

  if (
    !hasEnvironmentApiUrl &&
    !existsSync(
      globalConfigPath,
    ) &&
    !existsSync(
      projectEnvironmentPath,
    )
  ) {
    console.log(
      "Sky Code is not configured yet.",
    );

    console.log(
      "Run 'sky setup' to get started.",
    );

    return;
  }

  const config =
    await loadConfig(
      workingDirectory,
    );

  await runStartupHealthCheck(
    config,
  );

  const plugins =
    await loadPlugins({
      projectDirectory:
        workingDirectory,
      homeDirectory:
        homedir(),
      pluginDirs:
        config.pluginDirs,
    });

  const pluginSkills =
    mergePluginSkills(
      plugins,
    );

  const initialCatalog =
    await loadCatalog({
      homeDirectory:
        homedir(),
    });

  validateCatalogPluginConflicts(
    initialCatalog,
    pluginSkills,
  );

  const catalogManager =
    new CatalogManager({
      catalog:
        initialCatalog,

      pluginSkills,

      workingDirectory,
    });

  let catalog =
    catalogManager
      .getSnapshot();

  let activeCatalogSkills =
    catalogManager
      .getActiveSkills();

  const subAgents =
    mergePluginAgents(
      plugins,
    );

  const mcpServerConfigs =
    mergePluginMcpServers(
      config.mcpServers,
      plugins,
    );

  const hookRegistry =
    new HookRegistry();

  const loadedPluginHooks =
    await registerPluginHooks(
      plugins,
      hookRegistry,
    );

  let readlineForBackground:
    ReadlineInterface | null =
    null;

  let promptActive =
    false;

  let assistantOutputActive =
    false;

  const backgroundTerminalReporter =
    createBackgroundTerminalReporter({
      output,
      isPromptActive:
        () =>
          promptActive,
      getCurrentInput:
        () =>
          readlineForBackground
            ?.line ??
          "",
      redrawPrompt:
        () => {
          if (
            readlineForBackground
          ) {
            redrawReadlinePrompt(
              readlineForBackground,
            );
          }
        },
      isOutputActive:
        () =>
          assistantOutputActive,
    });

  let backgroundSessionReporter:
    ReturnType<
      typeof createBackgroundSessionReporter
    > | null =
    null;

  const backgroundTaskRegistry =
    new BackgroundTaskRegistry({
      hookRegistry,
      reporter:
        async (
          line,
          task,
          event,
        ): Promise<void> => {
          await backgroundTerminalReporter(
            line,
            task,
            event,
          );

          const sessionReporter =
            backgroundSessionReporter;

          if (
            sessionReporter
          ) {
            await sessionReporter(
              line,
              task,
              event,
            );
          }
        },
    });

  let mcpConnections:
    McpConnection[] = [];

  let mcpTools:
    McpToolDefinition[] = [];

  try {
    mcpConnections =
      await connectConfiguredMcpServers(
        mcpServerConfigs,
      );

    mcpTools =
      await loadMcpTools(
        mcpConnections,
      );
  } catch (error) {
    try {
      await closeMcpConnections(
        mcpConnections,
      );
    } catch {
      // Preserve the original startup error.
    }

    throw error;
  }

  let activeModel =
    config.defaultModel;

  const permissionController =
    new PermissionController(
      config.defaultPermissionMode,
    );

  let systemPrompt =
    createSkyCodeSystemPrompt(
      mcpTools,
      pluginSkills,
      subAgents,
      activeCatalogSkills,
    );

  const handlers =
    createSkyCodeToolHandlers(
      workingDirectory,
      mcpConnections,
      {
        agents:
          subAgents,
        apiUrl:
          config.apiUrl,
        apiKey:
          config.apiKey,
        getActiveModel:
          () =>
            activeModel,
        hookRegistry,
      },
      {
        getMode:
          () =>
            permissionController
              .getMode(),
      },
      {
        registry:
          backgroundTaskRegistry,
      },
    );

  const readline =
    createInterface({
      input,
      output,
    });

  readlineForBackground =
    readline;

  readline.setPrompt(
    "You: ",
  );

  let resumableSession:
    ResumableSession | null =
    null;

  try {
    resumableSession =
      await findLatestResumableSession(
        workingDirectory,
      );
  } catch (error) {
    printCliError(
      error,
      "Session history inspection",
    );

    console.log(
      "Starting with a fresh conversation.",
    );
  }

  const messages:
    ChatMessage[] = [];


  if (
    resumableSession
  ) {
    try {
      const resumeDecision =
        await promptForSessionResume(
          resumableSession,
          {
            question:
              async (
                prompt,
              ) =>
                readline.question(
                  prompt,
                ),

            write:
              (
                line,
              ) => {
                console.log(
                  line,
                );
              },
          },
        );

      if (
        resumeDecision ===
          "resume"
      ) {
        for (
          const message of
          resumableSession.messages
        ) {
          messages.push({
            role:
              message.role,

            content:
              message.content,
          });
        }


        console.log(
          `Resumed ${messages.length} conversation messages from the previous session.`,
        );
      } else {
        console.log(
          "Starting with a fresh conversation.",
        );
      }
    } catch (error) {
      printCliError(
        error,
        "Session resume selection",
      );

      console.log(
        "Starting with a fresh conversation.",
      );
    }
  }

  let sessionLogger:
    SessionLogger;

  try {
    sessionLogger =
      await createSessionLogger();
  } catch (error) {
    readline.close();

    readlineForBackground =
      null;

    try {
      await closeMcpConnections(
        mcpConnections,
      );
    } catch {
      // Preserve the original session-log error.
    }

    throw error;
  }

  backgroundSessionReporter =
    createBackgroundSessionReporter(
      sessionLogger,
    );

  await sessionLogger.append({
    type: "session_start",
    workingDirectory,
    model:
      activeModel,
  });

  let shutdownRequested =
    false;

  let sessionEndPromise:
    Promise<void> | null =
    null;

  let mcpClosePromise:
    Promise<void> | null =
    null;

  function saveSessionEnd():
    Promise<void> {
    if (
      !sessionEndPromise
    ) {
      sessionEndPromise =
        sessionLogger.append({
          type: "session_end",
          model:
            activeModel,
        });
    }

    return sessionEndPromise;
  }

  function closeMcpOnce():
    Promise<void> {
    if (
      !mcpClosePromise
    ) {
      mcpClosePromise =
        closeMcpConnections(
          mcpConnections,
        );
    }

    return mcpClosePromise;
  }

  function requestShutdown():
    void {
    if (
      shutdownRequested
    ) {
      return;
    }

    shutdownRequested = true;

    void (async () => {
      try {
        await backgroundTaskRegistry
          .cancelAll(
            "Sky Code is closing.",
          );
      } catch (error) {
        printCliError(
          error,
          "Background task cancellation",
        );
      }

      try {
        await saveSessionEnd();
      } catch (error) {
        printCliError(
          error,
          "Session log finalization",
        );
      }

      try {
        await closeMcpOnce();
      } catch (error) {
        printCliError(
          error,
          "MCP connection cleanup",
        );
      }

      output.write(
        "\nSky Code closed.\n",
      );

      readline.close();
    })();
  }

  readline.on(
    "SIGINT",
    requestShutdown,
  );

  process.on(
    "SIGINT",
    requestShutdown,
  );

  console.log(
    "Sky Code",
  );

  console.log(
    `LiteLLM: ${config.apiUrl}`,
  );

  console.log(
    `Active model: ${activeModel}`,
  );

  console.log(
    `Permission mode: ${permissionController.getMode()}`,
  );

  console.log(
    `Session log: ${sessionLogger.filePath}`,
  );

  console.log(
    `Plugins: ${plugins.length}`,
  );

  console.log(
    `Plugin skills: ${pluginSkills.length}`,
  );

  console.log(
    `Sub-agents: ${subAgents.length}`,
  );

  if (
    subAgents.length > 0
  ) {
    console.log(
      `Sub-agent names: ${subAgents
        .map(
          (
            agent,
          ) =>
            agent.name,
        )
        .join(", ")}`,
    );
  }

  if (
    pluginSkills.length > 0
  ) {
    console.log(
      `Plugin commands: ${pluginSkills
        .map(
          (
            skill,
          ) =>
            skill.command,
        )
        .join(", ")}`,
    );
  }

  console.log(
    `Hooks: ${hookRegistry.count()}`,
  );

  console.log(
    `Plugin hooks: ${loadedPluginHooks.length}`,
  );

  console.log(
    `MCP servers: ${mcpConnections.length}`,
  );

  console.log(
    `MCP tools: ${mcpTools.length}`,
  );

  console.log(
    "Type /model to select another model.",
  );

  console.log(
    "Type /permissions to view or change the permission mode.",
  );

  console.log(
    "Type /compact to reduce the active conversation context.",
  );

  console.log(
    "Type /tasks to view background tasks or /tasks cancel <task-id> to cancel one.",
  );

  console.log(
    "Press Ctrl+C to close Sky Code.",
  );

  console.log();

  try {
    while (true) {
      let userInput: string;

      try {
        promptActive =
          true;

        userInput = (
          await readline.question(
            "You: ",
          )
        ).trim();
      } catch {
        break;
      } finally {
        promptActive =
          false;
      }

      if (
        userInput === ""
      ) {
        continue;
      }

      if (
        userInput === "/model"
      ) {
        activeModel =
          await selectModel(
            config,
            readline,
            activeModel,
          );

        continue;
      }

      if (
        userInput ===
          "/permissions"
      ) {
        await selectPermissionMode(
          readline,
          permissionController,
        );

        continue;
      }

      if (
        userInput ===
          "/compact"
      ) {
        try {
          await compactCurrentContext(
            config,
            activeModel,
            messages,
            hookRegistry,
            sessionLogger,
          );
        } catch (error) {
          printCliError(
            error,
            "Context compaction",
          );

          console.log(
            "The active conversation history was not changed.",
          );

          console.log();
        }

        continue;
      }

      const backgroundTasksCommand =
        parseBackgroundTasksCommand(
          userInput,
        );

      if (
        backgroundTasksCommand
      ) {
        console.log(
          executeBackgroundTasksCommand(
            backgroundTasksCommand,
            backgroundTaskRegistry,
          ),
        );

        console.log();

        continue;
      }

      let historyCommand:
        ReturnType<
          typeof parseHistoryCommand
        >;

      try {
        historyCommand =
          parseHistoryCommand(
            userInput,
          );
      } catch (error) {
        printCliError(
          error,
          "History command",
        );

        console.log();

        continue;
      }

      if (
        historyCommand
      ) {
        try {
          const matches =
            await searchSessionHistory(
              sessionLogger.filePath,
              historyCommand.term,
            );

          console.log(
            formatHistorySearchResults(
              historyCommand.term,
              matches,
            ),
          );
        } catch (error) {
          printCliError(
            error,
            "History search",
          );
        }

        console.log();

        continue;
      }

      let catalogManagementCommand:
        ReturnType<
          typeof parseCatalogManagementCommand
        >;

      try {
        catalogManagementCommand =
          parseCatalogManagementCommand(
            userInput,
          );
      } catch (error) {
        printCliError(
          error,
          "Catalog management command",
        );

        console.log();

        continue;
      }

      if (
        catalogManagementCommand
      ) {
        try {
          const result =
            await catalogManager
              .execute(
                catalogManagementCommand,
              );

          catalog =
            result.catalog;

          activeCatalogSkills =
            result.activeSkills;

          systemPrompt =
            createSkyCodeSystemPrompt(
              mcpTools,
              pluginSkills,
              subAgents,
              activeCatalogSkills,
            );

          console.log(
            result.message,
          );
        } catch (error) {
          printCliError(
            error,
            "Catalog management command",
          );
        }

        console.log();

        continue;
      }

      let resolvedCatalogCommand:
        ReturnType<
          typeof resolveCatalogCommand
        >;

      try {
        resolvedCatalogCommand =
          resolveCatalogCommand(
            userInput,
            catalog.commands,
          );
      } catch (error) {
        printCliError(
          error,
          "Catalog command",
        );

        console.log();

        continue;
      }

      if (
        resolvedCatalogCommand
          ?.kind ===
          "shell"
      ) {
        try {
          const result =
            await executeCatalogShellCommand(
              resolvedCatalogCommand,
              permissionController
                .getMode(),
              workingDirectory,
            );

          console.log(
            result.output,
          );
        } catch (error) {
          printCliError(
            error,
            "Catalog shell command",
          );
        }

        console.log();

        continue;
      }

      const resolvedPluginCommand =
        resolvePluginSkillCommand(
          userInput,
          pluginSkills,
        );

      const conversationInput =
        resolvedCatalogCommand
          ?.kind ===
          "prompt"
          ? resolvedCatalogCommand
              .conversationInput
          : resolvedPluginCommand
              ?.conversationInput ??
            userInput;

      messages.push({
        role: "user",
        content:
          conversationInput,
      });

      await sessionLogger.append({
        type: "message",
        role: "user",
        content:
          userInput,
        model:
          activeModel,
      });

      try {
        const automaticCompactionResult =
          await runAutomaticContextCompaction({
            config,
            model:
              activeModel,
            messages,
            hookRegistry,
            sessionLogger,
          });

        if (
          automaticCompactionResult
        ) {
          console.log();
          console.log(
            "Automatic context compaction triggered.",
          );

          for (
            const line of
            formatContextCompactionResult(
              automaticCompactionResult,
            )
          ) {
            console.log(
              line,
            );
          }

          console.log();
        }
      } catch (error) {
        printCliError(
          error,
          "Automatic context compaction",
        );

        console.log(
          "The active conversation history was not changed.",
        );

        console.log();
      }

      assistantOutputActive =
        true;

      output.write(
        "Sky Code: ",
      );

      try {
        await completeConversationTurn(
          config,
          activeModel,
          messages,
          readline,
          sessionLogger,
          handlers,
          hookRegistry,
          systemPrompt,
        );
      } catch (error) {
        output.write(
          "\n",
        );

        printCliError(
          error,
          "Model request",
        );

        console.log(
          `The active model remains ${activeModel}.`,
        );

        console.log();

        const lastMessage =
          messages.at(-1);

        if (
          lastMessage?.role ===
            "user" &&
          lastMessage.content ===
            conversationInput
        ) {
          messages.pop();
        }
      } finally {
        assistantOutputActive =
          false;

        await backgroundTerminalReporter
          .flushPending();
      }
    }
  } finally {
    process.off(
      "SIGINT",
      requestShutdown,
    );

    promptActive =
      false;

    try {
      await backgroundTaskRegistry
        .cancelAll(
          "Sky Code is closing.",
        );
    } catch (error) {
      printCliError(
        error,
        "Background task cancellation",
      );
    }

    try {
      await saveSessionEnd();
    } catch (error) {
      printCliError(
        error,
        "Session log finalization",
      );
    }

    try {
      await closeMcpOnce();
    } catch (error) {
      printCliError(
        error,
        "MCP connection cleanup",
      );
    }

    readline.close();
  }
}

const currentFilePath =
  fileURLToPath(
    import.meta.url,
  );

const executedFilePath =
  process.argv[1]
    ? realpathSync(
        resolve(
          process.argv[1],
        ),
      )
    : "";

if (
  executedFilePath ===
  currentFilePath
) {
  runCli().catch(
    (error: unknown) => {
      printCliError(
        error,
        "Sky Code startup",
      );

      process.exitCode = 1;
    },
  );
}
