#!/usr/bin/env node

/**
 * Main Sky Code command-line application and executable entry point.
 *
 * Coordinates startup, configuration, plugins, catalog skills, MCP servers,
 * hooks, permissions, session logging and resumption, background tasks,
 * conversation compaction, model interaction, tool execution, interactive
 * commands, and graceful shutdown.
 *
 * Most feature modules are intentionally kept separate from this file.
 * index.ts connects those modules into the long-running interactive CLI and
 * owns the top-level lifecycle of a Sky Code process.
 */

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
  loadSkyMd,
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

/**
 * ANSI-coloured startup banner displayed when SkyCode launches.
 *
 * Uses bright magenta (\x1b[95m) for the tilde arc motif and the "Code"
 * portion of the wordmark, and white (\x1b[97m) for "Sky". The
 * process.stdout.isTTY check prevents ANSI escape codes from being emitted
 * when output is piped or redirected, so non-terminal output receives the
 * plain-text version instead. The reset code (\x1b[0m) returns subsequent
 * terminal text to its normal colour.
 */
const SKYCODE_BANNER = process.stdout.isTTY
  ? '\x1b[95m  ~ ~ ~\x1b[0m\n\x1b[95m ~ ~ ~ ~\x1b[0m\n\x1b[97mSky\x1b[0m\x1b[95mCode\x1b[0m'
  : '  ~ ~ ~\n ~ ~ ~ ~\nSkyCode';

/**
 * Braille frames cycled to animate the "thinking" indicator shown while
 * waiting for a model response to begin streaming. One full cycle through
 * all ten frames takes roughly 800ms at THINKING_SPINNER_INTERVAL_MS.
 */
const THINKING_SPINNER_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
];

const THINKING_SPINNER_INTERVAL_MS = 80;

/**
 * Shortens an absolute path under the current user's home directory to a
 * leading `~`, matching the shorthand already used in Sky Code's setup
 * wizard output (for example "Wrote ~/.sky-code/config.json"). Paths outside
 * the home directory are returned unchanged.
 *
 * @param {string} absolutePath - Path to shorten.
 * @returns {string} Path with a leading home-directory prefix replaced by
 * `~`, or the original path when it is not under the home directory.
 *
 * Side effects: none.
 */
function shortenHomePath(
  absolutePath: string,
): string {
  const home =
    homedir();

  return absolutePath.startsWith(
    home,
  )
    ? `~${absolutePath.slice(home.length)}`
    : absolutePath;
}

/**
 * Renders the post-startup status lines (endpoint, model, permission mode,
 * loaded extension counts, and so on) as an aligned, rounded-corner box.
 *
 * Border colour (bright magenta, matching SKYCODE_BANNER and the thinking
 * indicator) is applied only when stdout is a TTY; the same box shape and
 * alignment are used either way; this mirrors the isTTY-fallback convention
 * used elsewhere in Sky Code, which strips colour but not structure for
 * redirected output (see setup.ts's unconditional "─" divider for the same
 * pattern applied to box-drawing characters specifically).
 *
 * @param {ReadonlyArray<readonly [string, string]>} rows - Ordered
 * (label, value) pairs to display, one per line, in the same order and with
 * the same content as Sky Code's original plain "Label: value" startup log
 * lines.
 * @returns {string} Complete multi-line box text, ready to print. On a TTY,
 * the box is capped to the terminal's column width (falling back to 80 when
 * unavailable) and any line too long to fit is truncated with a trailing
 * "…"; non-TTY output always uses the natural, untruncated width, since
 * redirected output has no real screen to wrap around.
 *
 * Side effects: none.
 */
function renderStartupInfoPanel(
  rows: ReadonlyArray<
    readonly [string, string]
  >,
): string {
  const labelWidth =
    Math.max(
      ...rows.map(
        ([label]) =>
          label.length,
      ),
    );

  const contentLines =
    rows.map(
      ([label, value]) =>
        `${label.padEnd(labelWidth)}  ${value}`,
    );

  const naturalWidth =
    Math.max(
      ...contentLines.map(
        (line) =>
          line.length,
      ),
    );

  // A long value - most often the session log path - can otherwise force a
  // box wider than the terminal, which wraps mid-border and looks broken.
  // Redirected, non-TTY output has no real screen to wrap around, so it
  // always keeps the natural width instead.
  const innerWidth =
    output.isTTY
      ? Math.min(
          naturalWidth,
          Math.max(
            (output.columns ?? 80) - 4,
            20,
          ),
        )
      : naturalWidth;

  const displayLines =
    contentLines.map(
      (line) =>
        line.length > innerWidth
          ? `${line.slice(0, innerWidth - 1)}…`
          : line,
    );

  const horizontal =
    "─".repeat(
      innerWidth + 2,
    );

  const colorStart =
    output.isTTY
      ? "\x1b[95m"
      : "";

  const colorEnd =
    output.isTTY
      ? "\x1b[0m"
      : "";

  const top =
    `${colorStart}╭${horizontal}╮${colorEnd}`;

  const bottom =
    `${colorStart}╰${horizontal}╯${colorEnd}`;

  const middle =
    displayLines
      .map(
        (line) =>
          `${colorStart}│${colorEnd} ${line.padEnd(
            innerWidth,
          )} ${colorStart}│${colorEnd}`,
      )
      .join(
        "\n",
      );

  return [
    top,
    middle,
    bottom,
  ].join(
    "\n",
  );
}

/**
 * Interactive prompt label shown before the user's typed input.
 *
 * The arrow is coloured bright magenta (matching SKYCODE_BANNER and the
 * startup info panel border) only when stdout is a TTY; the underlying text
 * ("You " + arrow + trailing space) is identical either way so redirected
 * output and interactive terminals show the same wording.
 */
const PROMPT_LABEL =
  process.stdout.isTTY
    ? "You \x1b[95m❯\x1b[0m "
    : "You ❯ ";

/**
 * Label written immediately before each assistant response begins streaming.
 *
 * Uses the exact same colour treatment as SKYCODE_BANNER ("Sky" in white,
 * "Code" in bright magenta) so a user's turn (magenta PROMPT_LABEL arrow) and
 * the assistant's turn (this label) are both visually anchored and easy to
 * tell apart when scanning back through terminal scrollback, rather than
 * both appearing as plain, undifferentiated text. Colour is applied only
 * when stdout is a TTY; the underlying text ("SkyCode: ") is identical
 * either way so redirected output and interactive terminals show the same
 * wording.
 */
const RESPONSE_LABEL =
  process.stdout.isTTY
    ? "\x1b[97mSky\x1b[0m\x1b[95mCode\x1b[0m: "
    : "SkyCode: ";

/**
 * Builds a full-width horizontal divider printed directly above and below the
 * interactive prompt, so the user's typed input is unmistakably bounded and
 * separate from the assistant's response - a stronger visual boundary than
 * PROMPT_LABEL and RESPONSE_LABEL's colour alone.
 *
 * Coloured bright magenta (matching PROMPT_LABEL, RESPONSE_LABEL, and the
 * startup info panel border) only on a TTY; width matches the terminal's
 * current column count (falling back to 80 when unavailable) either way, so
 * the rule spans the same width a person would expect a horizontal line to
 * span in their own terminal.
 *
 * @returns {string} A single "─" line spanning the terminal width, optionally
 * wrapped in ANSI colour codes.
 *
 * Side effects: none.
 */
function renderPromptDivider(): string {
  const line =
    "─".repeat(
      output.columns ?? 80,
    );

  return output.isTTY
    ? `\x1b[95m${line}\x1b[0m`
    : line;
}

/**
 * Starts an animated "Thinking..." indicator on the current terminal line and
 * returns a function that stops it and clears the line.
 *
 * The indicator is a no-op when stdout is not a TTY (piped or redirected
 * output), matching the isTTY-fallback convention used for SKYCODE_BANNER, so
 * redirected output never receives raw carriage-return/ANSI spinner frames
 * that would only make sense on an interactive terminal.
 *
 * @returns {() => void} Stop function. Safe to call more than once; only the
 * first call has any effect. Callers should invoke it as soon as the model's
 * response begins arriving, and unconditionally afterward (for example in a
 * finally block) so an empty response or a thrown request error cannot leave
 * the animation running indefinitely.
 *
 * Side effects: while active, writes colour and cursor-control ANSI escape
 * sequences to stdout on a recurring timer. The returned stop function clears
 * that timer and erases the indicator's terminal line.
 */
function startThinkingIndicator(): () => void {
  if (
    !output.isTTY
  ) {
    return () => {};
  }

  let frameIndex =
    0;

  let stopped =
    false;

  const interval =
    setInterval(
      () => {
        output.write(
          `\r\x1b[95m${
            THINKING_SPINNER_FRAMES[frameIndex]
          } Thinking...\x1b[0m`,
        );

        frameIndex =
          (frameIndex + 1) %
          THINKING_SPINNER_FRAMES.length;
      },
      THINKING_SPINNER_INTERVAL_MS,
    );

  return () => {
    if (
      stopped
    ) {
      return;
    }

    stopped =
      true;

    clearInterval(
      interval,
    );

    // \x1b[2K clears the entire current line so the model's real output (or
    // the next prompt) starts from a clean line rather than appending after
    // leftover spinner characters; \r then returns the cursor to column 0.
    output.write(
      "\r\x1b[2K",
    );
  };
}

// Limit a single conversational turn to twenty consecutive model-request/tool
// cycles. This prevents a malformed or looping model response from invoking
// tools indefinitely without returning control to the user.
const MAX_TOOL_ROUNDS = 20;

/**
 * Prefix of the error thrown by parseSkyToolBlockJson() when a model's
 * sky-tool block cannot be parsed as JSON. Matched here so the CLI can offer
 * guidance specific to a malformed live model response, rather than falling
 * through to formatCliErrorReport's generic "referenced JSON or configuration
 * file" guidance, which is accurate for on-disk files like plugin.json but
 * misleading here since there is no file for the person to go edit.
 */
const SKY_TOOL_INVALID_JSON_PREFIX =
  "The sky-tool block contains invalid JSON:";

/**
 * Chooses accurate recovery guidance for a failed model request, overriding
 * the generic inferred guidance when the failure is a malformed sky-tool
 * block rather than an on-disk configuration problem.
 *
 * @param {unknown} error - Failure thrown while completing a conversation turn.
 * @returns {string | undefined} Explicit next-step guidance, or undefined to
 * let formatCliErrorReport fall back to its generic inference.
 *
 * Side effects: none.
 */
function nextStepForModelRequestError(
  error:
    unknown,
): string | undefined {
  const message =
    error instanceof
      Error
      ? error.message
      : String(
          error,
        );

  if (
    message.startsWith(
      SKY_TOOL_INVALID_JSON_PREFIX,
    )
  ) {
    return "This is a malformed tool call from the model, not a file to edit. Try asking again, or switch models with /model.";
  }

  return undefined;
}

/**
 * Formats an unknown failure as Sky Code's standard CLI error report and
 * writes every resulting line to stderr.
 *
 * @param {unknown} error - Error or other thrown value to report.
 * @param {string} operation - Human-readable name of the operation that
 * failed, included as context in the formatted report.
 * @param {string} [nextStep] - Optional explicit recovery guidance that
 * overrides the generic inferred guidance in formatCliErrorReport. Callers
 * that can identify a more specific, accurate cause than the generic
 * message-pattern classifier should supply this.
 * @returns {void} This function does not return a value.
 *
 * Side effect: writes one or more error-report lines to stderr.
 */
function printCliError(
  error:
    unknown,

  operation:
    string,

  nextStep?:
    string,
): void {
  for (
    const line of
    formatCliErrorReport(
      error,
      {
        operation,

        nextStep,
      },
    )
  ) {
    console.error(
      line,
    );
  }
}

/**
 * Result of streaming one assistant turn from the configured model.
 *
 * The complete response is retained even when it is not printed immediately,
 * because a response beginning with a sky-tool block is interpreted as a tool
 * request rather than ordinary assistant output.
 */
interface StreamedTurn {
  /** Complete model response accumulated from all streamed chunks. */
  responseText: string;
  /** Whether ordinary assistant text was actually written to stdout. */
  displayedText: boolean;
}

/**
 * Converts a completed Sky Code tool execution into the user-role message
 * sent back to the model for the next tool round.
 *
 * The model receives the tool name, success flag, output text, and explicit
 * instructions to continue responding or request another tool if needed.
 *
 * @param {SkyToolRequest} request - Tool request that was executed.
 * @param {ToolExecutionResult} result - Result produced by the tool handler.
 * @returns {string} Plain-text message suitable for adding to model context.
 */
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

/**
 * Streams one model response while deciding whether its leading content is
 * normal user-visible text or an internal sky-tool request.
 *
 * Initial chunks are temporarily buffered because the marker ` ```sky-tool `
 * may arrive across multiple streaming chunks. Once the accumulated prefix can
 * no longer be the start of that marker, buffered content is emitted normally.
 * If the response does begin with the marker, it remains hidden and is later
 * parsed as a tool request by completeConversationTurn().
 *
 * @param {AppConfig} config - Validated application and API configuration.
 * @param {string} activeModel - Model identifier to use for this request.
 * @param {ChatMessage[]} messages - Current conversation context sent to the
 * model.
 * @param {string} systemPrompt - Active Sky Code system prompt describing
 * tools, skills, agents, and operating rules.
 * @returns {Promise<StreamedTurn>} Complete model response plus an indication
 * of whether ordinary response text was displayed.
 * @throws {Error} If the underlying model request or stream processing fails.
 *
 * Side effects: performs a model API request and may stream response text to
 * stdout as chunks arrive. Displays an animated "Thinking..." indicator (see
 * startThinkingIndicator()) from just before the request starts until the
 * first response chunk arrives, an empty response resolves, or the request
 * throws.
 */
async function streamModelTurn(
  config: AppConfig,
  activeModel: string,
  messages: ChatMessage[],
  systemPrompt: string,
): Promise<StreamedTurn> {
  let responseText = "";
  let pendingText = "";

  // Output begins in an undecided state because streaming can split the
  // sky-tool opening marker across arbitrary network chunks.
  let displayMode:
    | "undetermined"
    | "normal"
    | "tool" =
    "undetermined";

  let displayedText = false;

  const stopThinkingIndicator =
    startThinkingIndicator();

  let response:
    string;

  try {
    response =
      await streamChatCompletion(
        config,
        activeModel,
        messages,
        (content) => {
          // The first chunk of any kind means the model has begun
          // responding, so the "thinking" wait is over regardless of
          // whether this turn ends up being displayed text or a hidden
          // sky-tool block.
          stopThinkingIndicator();

          // Always preserve the entire response for logging, conversation
          // history, and later sky-tool parsing.
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

          // Until the response type is known, keep chunks out of the terminal.
          pendingText += content;

          const trimmedStart =
            pendingText.trimStart();

          // If the text received so far is still only a prefix of the marker,
          // wait for another chunk before deciding whether to display it.
          if (
            "```sky-tool".startsWith(
              trimmedStart,
            )
          ) {
            return;
          }

          // A completed marker identifies an internal tool request. Its textual
          // representation should not be printed as ordinary assistant prose.
          if (
            trimmedStart.startsWith(
              "```sky-tool",
            )
          ) {
            displayMode = "tool";
            return;
          }

          // The accumulated prefix cannot be a tool marker, so all buffered text
          // belongs to the normal assistant response and can now be emitted.
          displayMode = "normal";

          output.write(
            pendingText,
          );

          displayedText = true;
          pendingText = "";
        },
        systemPrompt,
      );
  } finally {
    // Guards against a completely empty response (the callback above never
    // ran) and against the request throwing before any content arrived;
    // stopThinkingIndicator() is itself safe to call more than once.
    stopThinkingIndicator();
  }

  // A short response may end before streaming supplied enough characters to
  // make the normal/tool decision inside the chunk callback.
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

/**
 * Interactively retrieves the endpoint's available models and lets the user
 * choose a new active model for the current Sky Code session.
 *
 * Retrieval failures and empty model lists are non-fatal: the current model is
 * retained and the user returns to the main prompt. Pressing Enter at the
 * selection prompt also leaves the current model unchanged.
 *
 * @param {AppConfig} config - Validated API configuration used to retrieve
 * available models.
 * @param {ReadlineInterface} readline - Active CLI readline interface.
 * @param {string} currentModel - Model currently selected for conversation
 * turns.
 * @returns {Promise<string>} Newly selected model, or currentModel when no
 * valid change is made.
 *
 * Side effects: may perform an API request and writes choices, status, or
 * validation messages to the terminal.
 */
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
    // Model-list failure should not terminate an otherwise usable session.
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

  // Restrict input to decimal digits before converting it to an array index.
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

  // Display numbering starts at one while JavaScript arrays start at zero.
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

/**
 * Displays the available permission modes and optionally changes the active
 * PermissionController for the current session.
 *
 * Pressing Enter keeps the existing mode. Invalid selections are reported but
 * do not throw or terminate the CLI. Selecting bypass mode prints an explicit
 * warning because that mode disables tool approval prompts.
 *
 * @param {ReadlineInterface} readline - Active CLI readline interface.
 * @param {PermissionController} controller - Mutable controller holding the
 * session's current permission mode.
 * @returns {Promise<void>} Resolves after the mode is kept or updated.
 *
 * Side effect: reads terminal input, writes status text, and may mutate the
 * active PermissionController.
 */
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

/**
 * Runs a user-requested manual compaction of the current conversation context
 * and prints the resulting compaction summary.
 *
 * The messages array is passed directly to the compaction runtime, which owns
 * the actual context-reduction behavior and associated hook/session events.
 *
 * @param {AppConfig} config - Active application configuration.
 * @param {string} activeModel - Model used when compaction requires model
 * processing.
 * @param {ChatMessage[]} messages - Mutable active conversation history.
 * @param {HookRegistry} hookRegistry - Registry used for compaction hooks.
 * @param {SessionLogger} sessionLogger - Logger used to record compaction
 * activity.
 * @returns {Promise<void>} Resolves after compaction completes and its result
 * is displayed.
 * @throws {Error} If the compaction runtime or one of its dependencies fails.
 *
 * Side effects: may make a model request, mutate active conversation context,
 * write session records, execute hooks, and print terminal output.
 */
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

/**
 * Completes one user conversation turn, including any model-request/tool-result
 * cycles required before the model produces its final ordinary response.
 *
 * Each assistant response is logged and appended to conversation context. If
 * it contains a Sky Code tool request, readline is paused while the tool runs,
 * hooks are applied, the result is logged, and a synthetic tool-result message
 * is added so the model can continue the same turn.
 *
 * Background-tool results may intentionally return control to the prompt
 * immediately. Otherwise model/tool cycling continues until a normal response
 * is produced or MAX_TOOL_ROUNDS is reached.
 *
 * @param {AppConfig} config - Active application/API configuration.
 * @param {string} activeModel - Model used for this conversation turn.
 * @param {ChatMessage[]} messages - Mutable conversation history.
 * @param {ReadlineInterface} readline - Active terminal readline interface.
 * @param {SessionLogger} sessionLogger - Current append-only session logger.
 * @param {ToolHandlers} handlers - Tool implementations available to the
 * model.
 * @param {HookRegistry} hookRegistry - Hooks wrapped around tool execution.
 * @param {string} systemPrompt - Current generated system prompt.
 * @returns {Promise<void>} Resolves once control should return to the user.
 * @throws {Error} If model streaming, logging, hook/tool execution fails, or
 * the model exceeds MAX_TOOL_ROUNDS consecutive tool requests.
 *
 * Side effects: performs model requests, executes tools and hooks, mutates
 * conversation history, pauses/resumes readline, writes session records, and
 * writes response/tool status text to the terminal.
 */
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
  // One loop iteration represents one model response and, when requested, one
  // associated tool execution before returning the result to the model.
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

    // Log the exact complete model response, including hidden sky-tool blocks,
    // before parsing or executing any requested tool.
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

    // No tool block means the assistant turn is finished and control can
    // return to the interactive user prompt.
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

    // Readline is paused while tool handlers may themselves interact with the
    // terminal; this avoids competing reads and prompt redraw problems.
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
      // Tool execution can alter terminal raw-mode state. Always resume the
      // main interface and restore raw mode even when the tool throws.
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

    // Some background-tool operations are complete once queued or otherwise
    // handled asynchronously; they should return directly to the user prompt
    // instead of automatically asking the model for another response.
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

    // Tool results are represented as a user-role message for the next model
    // request so the model can inspect the outcome and continue the same turn.
    messages.push({
      role: "user",
      content:
        createToolResultMessage(
          toolRequest,
          toolResult,
        ),
    });
  }

  // Reaching this point means every allowed round requested another tool,
  // indicating a likely model/tool loop rather than a completed turn.
  throw new Error(
    `SkyCode stopped after ${MAX_TOOL_ROUNDS} consecutive tool requests.`,
  );
}

/**
 * Retrieves and combines tool definitions advertised by every connected MCP
 * server.
 *
 * Connections are queried sequentially. If any server fails, its error is
 * wrapped with that server's configured name so startup diagnostics identify
 * the failing MCP source.
 *
 * @param {readonly McpConnection[]} connections - Active MCP connections whose
 * tool catalogs should be queried.
 * @returns {Promise<McpToolDefinition[]>} Combined MCP tool definitions in
 * connection order.
 * @throws {Error} If any MCP server fails to return its tool list.
 *
 * Side effect: performs list-tools requests against connected MCP servers.
 */
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

/**
 * Starts and runs the Sky Code interactive command-line application.
 *
 * Startup performs the following major phases:
 * - handles the special `sky setup` command;
 * - verifies that first-use configuration is available;
 * - loads configuration and performs startup health checks;
 * - discovers plugins, catalog skills, sub-agents, hooks, and MCP servers;
 * - creates background-task, permission, tool, session, and readline state;
 * - optionally resumes the previous conversation;
 * - enters the interactive user-command and model-conversation loop;
 * - cancels background work, finalizes the session log, and closes MCP
 *   connections during shutdown.
 *
 * @returns {Promise<void>} Resolves after the CLI exits normally.
 * @throws {Error} If a fatal startup or runtime operation cannot be recovered
 * locally. The executable entry-point wrapper below reports these failures and
 * sets a non-zero exit code.
 *
 * Side effects: reads configuration and session files, connects to network and
 * MCP services, loads plugins, creates session logs, installs SIGINT handlers,
 * performs model/tool requests, accepts terminal input, writes terminal output,
 * and performs shutdown cleanup.
 */
export async function runCli():
  Promise<void> {
  // `sky diagnose` must work even when normal SkyCode configuration cannot
  // be loaded, so route it before setup and all normal startup processing.
  if (
    process.argv[2] ===
    "diagnose"
  ) {
    const {
      runDiagnostics,
      formatDiagnostics,
    } = await import(
      "./diagnose.js"
    );

    const results =
      await runDiagnostics();

    console.log(
      formatDiagnostics(
        results,
        process.stdout.isTTY ??
          false,
      ),
    );

    process.exit(0);
  }

  // `sky setup` is a standalone command and does not initialize the normal
  // interactive runtime or any MCP/plugin/session resources.
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

  // An environment-provided API URL is sufficient evidence that configuration
  // may be available even when neither known on-disk configuration file exists.
  const hasEnvironmentApiUrl =
    typeof process.env
      .LITELLM_API_URL ===
      "string" &&
    process.env
      .LITELLM_API_URL
      .trim() !==
      "";

  // Provide a first-run instruction instead of letting loadConfig() fail with
  // missing required values when none of the expected configuration sources
  // appears to exist.
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
      "SkyCode is not configured yet.",
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

  // Plugin skills and catalog entries share command space, so conflicts must
  // be rejected before an ambiguous interactive command can be accepted.
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

  // Keep snapshots locally because catalog-management commands can update both
  // the available commands and the currently enabled catalog skills at runtime.
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

  // User-configured and plugin-provided MCP definitions are merged before any
  // connections are opened.
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

  // Background completion notifications may arrive while readline is active.
  // The reporter accesses this variable lazily after the interface is created.
  let readlineForBackground:
    ReadlineInterface | null =
    null;

  // These flags let background reporting decide whether it must redraw the
  // interactive input line or defer output until assistant streaming finishes.
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

  // Session logging cannot be wired into background reports until the session
  // logger is successfully created later in startup.
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
          // Always report background state to the terminal first.
          await backgroundTerminalReporter(
            line,
            task,
            event,
          );

          // Once session logging exists, mirror the same background event into
          // the persistent session log.
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
    // If startup fails after one or more MCP connections were opened, close
    // whatever was established before propagating the original startup error.
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

  // Optional user-authored operating rules from ~/.sky-code/sky.md. Loaded
  // once at startup; like other global configuration, changes require a
  // restart to take effect.
  const skyMdContent =
    await loadSkyMd();

  // The system prompt is generated from the tool/skill/agent capabilities
  // active at this moment. It is regenerated later when catalog state changes.
  let systemPrompt =
    createSkyCodeSystemPrompt(
      mcpTools,
      pluginSkills,
      subAgents,
      activeCatalogSkills,
      skyMdContent,
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

  // Expose the now-created readline interface to asynchronous background
  // terminal reporting.
  readlineForBackground =
    readline;

  readline.setPrompt(
    PROMPT_LABEL,
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
    // Broken or unreadable historical sessions should not prevent a new Sky
    // Code conversation from starting.
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
        // Copy only role/content pairs into live model context rather than
        // retaining additional session-record metadata.
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
      // A resume-selection problem is recoverable; start an empty conversation
      // instead of failing the entire CLI.
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
    // No interactive session should continue if its required audit/session log
    // cannot be created. Clean up resources already initialized first.
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

  // Background events can now be persisted because a live session logger
  // exists.
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

  // Shutdown may be triggered through readline SIGINT, process SIGINT, or
  // normal loop termination. Shared flags/promises keep cleanup idempotent.
  let shutdownRequested =
    false;

  let sessionEndPromise:
    Promise<void> | null =
    null;

  let mcpClosePromise:
    Promise<void> | null =
    null;

  /**
   * Appends the session_end record at most once.
   *
   * Multiple shutdown paths can call this helper. Caching the first promise
   * prevents duplicate session-end records while allowing every caller to wait
   * on the same in-progress append.
   *
   * @returns {Promise<void>} Shared promise for session-end persistence.
   */
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

  /**
   * Closes all MCP connections at most once during shutdown.
   *
   * @returns {Promise<void>} Shared promise representing MCP cleanup.
   */
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

  /**
   * Initiates graceful shutdown in response to Ctrl+C.
   *
   * The first invocation cancels background tasks, finalizes the session log,
   * closes MCP connections, prints the shutdown message, and closes readline.
   * Later invocations return immediately so duplicate SIGINT events cannot
   * launch overlapping cleanup sequences.
   *
   * @returns {void} Cleanup continues asynchronously after this function
   * returns.
   *
   * Side effects: cancels tasks, writes session data, closes MCP connections,
   * writes terminal output, and closes readline.
   */
  function requestShutdown():
    void {
    if (
      shutdownRequested
    ) {
      return;
    }

    shutdownRequested = true;

    // The signal callback itself remains synchronous while the asynchronous
    // cleanup sequence runs in a deliberately detached promise.
    void (async () => {
      try {
        await backgroundTaskRegistry
          .cancelAll(
            "SkyCode is closing.",
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
        "\nSkyCode closed.\n",
      );

      // Closing readline causes any pending question/main loop to terminate.
      readline.close();
    })();
  }

  // Handle Ctrl+C originating through either readline or the process itself.
  // requestShutdown() is idempotent, so both paths can safely point to it.
  readline.on(
    "SIGINT",
    requestShutdown,
  );

  process.on(
    "SIGINT",
    requestShutdown,
  );

  // Display the effective runtime state after all startup components have
  // initialized successfully.
  console.log(
    SKYCODE_BANNER,
  );

  console.log();

  // Rows are collected in the same order, with the same conditional
  // inclusion logic, as the plain "Label: value" lines this panel replaced,
  // so the information shown is unchanged - only its presentation is new.
  const startupInfoRows: Array<
    readonly [string, string]
  > = [
    [
      "LiteLLM",
      config.apiUrl,
    ],
    [
      "Active model",
      activeModel,
    ],
    [
      "Permission mode",
      permissionController.getMode(),
    ],
    [
      "Session log",
      shortenHomePath(
        sessionLogger.filePath,
      ),
    ],
    [
      "Plugins",
      String(
        plugins.length,
      ),
    ],
    [
      "Plugin skills",
      String(
        pluginSkills.length,
      ),
    ],
    [
      "Sub-agents",
      String(
        subAgents.length,
      ),
    ],
  ];

  if (
    subAgents.length > 0
  ) {
    startupInfoRows.push([
      "Sub-agent names",
      subAgents
        .map(
          (
            agent,
          ) =>
            agent.name,
        )
        .join(", "),
    ]);
  }

  if (
    pluginSkills.length > 0
  ) {
    startupInfoRows.push([
      "Plugin commands",
      pluginSkills
        .map(
          (
            skill,
          ) =>
            skill.command,
        )
        .join(", "),
    ]);
  }

  startupInfoRows.push(
    [
      "Hooks",
      String(
        hookRegistry.count(),
      ),
    ],
    [
      "Plugin hooks",
      String(
        loadedPluginHooks.length,
      ),
    ],
    [
      "MCP servers",
      String(
        mcpConnections.length,
      ),
    ],
    [
      "MCP tools",
      String(
        mcpTools.length,
      ),
    ],
  );

  console.log(
    renderStartupInfoPanel(
      startupInfoRows,
    ),
  );

  console.log();

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
    "Type /diagnose to run setup diagnostics.",
  );

  console.log(
    "Type /tasks to view background tasks or /tasks cancel <task-id> to cancel one.",
  );

  console.log(
    "Press Ctrl+C to close SkyCode.",
  );

  console.log();

  try {
    // Each loop iteration accepts one non-empty user command/message and then
    // either handles it locally or starts a model conversation turn.
    while (true) {
      let userInput: string;

      console.log(
        renderPromptDivider(),
      );

      try {
        // Background terminal reporting uses promptActive to know whether a
        // notification must preserve and redraw the user's current input line.
        promptActive =
          true;

        userInput = (
          await readline.question(
            PROMPT_LABEL,
          )
        ).trim();
      } catch {
        // Readline rejection typically means the interface was closed, such
        // as during Ctrl+C shutdown. Leaving the loop triggers final cleanup.
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

      // Closes the divider opened above, so every non-empty submission - a
      // command or a conversational message alike - is bounded top and
      // bottom before anything else is printed for it. An empty submission
      // has nothing to bound, so it skips straight back to the loop's next
      // divider instead of printing a redundant pair here.
      console.log(
        renderPromptDivider(),
      );

      // Built-in local commands are processed before catalog/plugin/model
      // conversation routing.
      if (
        userInput ===
          "/diagnose"
      ) {
        const {
          runDiagnostics,
          formatDiagnostics,
        } = await import(
          "./diagnose.js"
        );

        const results =
          await runDiagnostics();

        console.log(
          formatDiagnostics(
            results,
            process.stdout.isTTY ??
              false,
          ),
        );

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
          // Manual compaction failure is recoverable and must leave the active
          // conversation history intact.
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
        // Invalid history command syntax is a local command error, not a fatal
        // CLI failure or model prompt.
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

          // Catalog management may enable, disable, add, or otherwise alter
          // runtime catalog state, so refresh all cached catalog views.
          catalog =
            result.catalog;

          activeCatalogSkills =
            result.activeSkills;

          // The model must immediately receive the revised skill set, requiring
          // regeneration of the system prompt after catalog changes.
          systemPrompt =
            createSkyCodeSystemPrompt(
              mcpTools,
              pluginSkills,
              subAgents,
              activeCatalogSkills,
              skyMdContent,
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

      // Shell-type catalog commands are executed locally and do not become
      // model conversation messages.
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

      // Prompt-type catalog commands and plugin skill commands transform the
      // raw terminal command into the text that should actually reach the
      // model. Ordinary input is passed through unchanged.
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

      // Persist what the person actually typed, not the expanded catalog or
      // plugin prompt sent internally to the model.
      await sessionLogger.append({
        type: "message",
        role: "user",
        content:
          userInput,
        model:
          activeModel,
      });

      try {
        // Automatic compaction runs after the new user message enters context
        // but before asking the model to answer it.
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
        // Automatic compaction is an optimization rather than a requirement
        // for answering the user, so failure is reported and conversation
        // processing continues with unchanged history.
        printCliError(
          error,
          "Automatic context compaction",
        );

        console.log(
          "The active conversation history was not changed.",
        );

        console.log();
      }

      // Background reporters use this flag to avoid injecting notifications
      // into the middle of streamed assistant text.
      assistantOutputActive =
        true;

      // A blank line always separates the user's echoed input from the
      // assistant's turn, so RESPONSE_LABEL reliably marks where each
      // response begins even when automatic compaction did not already
      // print one above.
      console.log();

      output.write(
        RESPONSE_LABEL,
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
          nextStepForModelRequestError(
            error,
          ),
        );

        console.log(
          `The active model remains ${activeModel}.`,
        );

        console.log();

        const lastMessage =
          messages.at(-1);

        // If model processing failed before adding anything beyond the current
        // conversation input, remove that input from live model history. The
        // original typed message remains recorded in the session log.
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

        // Notifications deferred while the assistant was streaming can now be
        // printed safely before the next user prompt appears.
        await backgroundTerminalReporter
          .flushPending();
      }
    }
  } finally {
    // Normal loop exit and signal-driven shutdown converge here. Remove the
    // process handler first, then repeat idempotent cleanup to ensure resources
    // are closed even if requestShutdown() was never invoked.
    process.off(
      "SIGINT",
      requestShutdown,
    );

    promptActive =
      false;

    try {
      await backgroundTaskRegistry
        .cancelAll(
          "SkyCode is closing.",
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

// Compare the canonical filesystem paths rather than raw URL/argv text so this
// module runs the CLI only when it is the executable entry point, not when it
// is imported by tests or another module.
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
  // Fatal errors escaping runCli() are formatted consistently and represented
  // by a non-zero process exit status without bypassing normal Node teardown.
  runCli().catch(
    (error: unknown) => {
      printCliError(
        error,
        "SkyCode startup",
      );

      process.exitCode = 1;
    },
  );
}
