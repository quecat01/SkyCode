/**
 * Forked-process worker for one delegated Sky Code sub-agent task.
 *
 * The parent process sends a SubAgentWorkerRequest over Node IPC. This worker
 * validates the runtime shape of that message, builds a minimal AppConfig and
 * chat request, executes one streamed model completion, and returns exactly one
 * success or failure result over IPC.
 *
 * The worker intentionally accepts only one task at a time and disconnects its
 * IPC channel after sending the result so the child process can terminate
 * cleanly.
 */
import {
  streamChatCompletion,
  type ChatMessage,
} from "./chat.js";

import type {
  AppConfig,
} from "./config.js";

import type {
  SubAgentWorkerFailure,
  SubAgentWorkerRequest,
  SubAgentWorkerResponse,
  SubAgentWorkerSuccess,
} from "./agents.js";

/**
 * Checks whether an unknown IPC value is a non-null, non-array object.
 *
 * @param {unknown} value - Runtime value to inspect.
 * @returns {boolean} True when the value can be treated as an object record.
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
 * Performs runtime structural validation of an incoming sub-agent worker request.
 *
 * IPC messages are untrusted runtime values even though the parent uses a
 * TypeScript interface. This guard confirms the request discriminator, IDs,
 * task, nested agent/config objects, optional fields, and required string
 * properties before handleRequest() receives the message.
 *
 * This validates field types only; higher-level normalization such as non-empty
 * text validation already occurs in the parent before the worker is forked.
 *
 * @param {unknown} value - IPC message received from the parent process.
 * @returns {boolean} True when value matches SubAgentWorkerRequest structurally.
 */
function isWorkerRequest(
  value: unknown,
): value is SubAgentWorkerRequest {
  if (!isRecord(value)) {
    return false;
  }

  if (
    value.type !==
      "run" ||
    typeof value.requestId !==
      "string" ||
    typeof value.task !==
      "string" ||
    !isRecord(value.agent) ||
    !isRecord(value.config)
  ) {
    return false;
  }

  return (
    typeof value.agent.name ===
      "string" &&
    typeof value.agent.description ===
      "string" &&
    typeof value.agent.systemPrompt ===
      "string" &&
    (
      value.agent.model ===
        undefined ||
      typeof value.agent.model ===
        "string"
    ) &&
    (
      value.context ===
        undefined ||
      typeof value.context ===
        "string"
    ) &&
    typeof value.config.apiUrl ===
      "string" &&
    typeof value.config.apiKey ===
      "string" &&
    typeof value.config.defaultModel ===
      "string"
  );
}

/**
 * Sends one worker result to the parent process and then closes the IPC channel.
 *
 * If no IPC send function exists, or if process.send reports an error, the
 * worker sets exitCode to 1. After the send callback runs, an active IPC
 * connection is disconnected so the process is not kept alive unnecessarily.
 *
 * @param {SubAgentWorkerResponse} response - Success or failure result to send.
 * @returns {void}
 *
 * Side effects: sends IPC data, may set process.exitCode, and may disconnect the
 * worker from its parent.
 */
function sendResponse(
  response:
    SubAgentWorkerResponse,
): void {
  if (!process.send) {
    process.exitCode = 1;
    return;
  }

  process.send(
    response,
    (
      error,
    ) => {
      if (error) {
        process.exitCode = 1;
      }

      if (process.connected) {
        process.disconnect?.();
      }
    },
  );
}

/**
 * Builds the user-role message supplied to the delegated model request.
 *
 * The primary task is always included. Optional context is appended under a
 * separate heading only when it contains non-whitespace text.
 *
 * @param {SubAgentWorkerRequest} request - Validated delegated worker request.
 * @returns {string} Model-facing delegated task and optional context text.
 */
function createTaskMessage(
  request:
    SubAgentWorkerRequest,
): string {
  const lines = [
    "Delegated task:",
    request.task,
  ];

  if (
    request.context !==
      undefined &&
    request.context.trim() !==
      ""
  ) {
    lines.push(
      "",
      "Delegated context:",
      request.context,
    );
  }

  return lines.join("\n");
}

/**
 * Guards this worker against processing more than one delegated task.
 *
 * A worker is created for a single task, so any additional request received
 * while the first is active is rejected instead of running concurrently.
 */
let handlingRequest =
  false;

/**
 * Executes one validated sub-agent worker request.
 *
 * A second request received after processing begins is rejected immediately.
 * The selected model is the agent override when present, otherwise the supplied
 * default model. A minimal AppConfig is constructed because streamChatCompletion
 * expects the full configuration shape even though sub-agents do not use MCP
 * servers, plugins, permissions, or conversation compaction here.
 *
 * Streaming deltas are intentionally ignored; the worker sends only the final
 * completed output to the parent through IPC.
 *
 * @param {SubAgentWorkerRequest} request - Validated task request from parent.
 * @returns {Promise<void>} Resolves after a success or failure response is sent.
 *
 * Side effects: performs a model API request and sends one IPC result.
 */
async function handleRequest(
  request:
    SubAgentWorkerRequest,
): Promise<void> {
  if (handlingRequest) {
    const response:
      SubAgentWorkerFailure = {
      type:
        "result",
      requestId:
        request.requestId,
      success:
        false,
      error:
        "The sub-agent worker is already processing a task.",
      workerPid:
        process.pid,
    };

    sendResponse(response);
    return;
  }

  handlingRequest = true;

  // An agent-specific model takes precedence over the parent's current
  // default model for this delegated task.
  const model =
    request.agent.model ??
    request.config
      .defaultModel;

  // streamChatCompletion expects AppConfig, but this isolated worker only
  // needs API/model fields. Remaining values are inert defaults required to
  // satisfy that shared runtime contract.
  const config:
    AppConfig = {
    apiUrl:
      request.config.apiUrl,
    apiKey:
      request.config.apiKey,
    defaultModel:
      request.config
        .defaultModel,
    defaultPermissionMode:
      "default",
    compactionThreshold:
      6_000,
    compactionStrategy:
      "summarise",
    compactionWindowSize:
      20,
    mcpServers: [],
    pluginDirs: [],
  };

  // A sub-agent starts with a fresh one-message conversation; it does not
  // inherit the main Sky Code conversation history.
  const messages:
    ChatMessage[] = [
      {
        role:
          "user",
        content:
          createTaskMessage(
            request,
          ),
      },
    ];

  // Convert every model-side exception into a structured worker failure so
  // the parent receives one consistent IPC result shape.
  try {
    const output =
      await streamChatCompletion(
        config,
        model,
        messages,
        () => {
          // The worker returns one completed result through IPC.
        },
        request.agent
          .systemPrompt,
      );

    const response:
      SubAgentWorkerSuccess = {
      type:
        "result",
      requestId:
        request.requestId,
      success:
        true,
      output,
      model,
      workerPid:
        process.pid,
    };

    sendResponse(response);
  } catch (error) {
    const response:
      SubAgentWorkerFailure = {
      type:
        "result",
      requestId:
        request.requestId,
      success:
        false,
      error:
        error instanceof
          Error
          ? error.message
          : String(error),
      model,
      workerPid:
        process.pid,
    };

    sendResponse(response);
  }
}

/**
 * Receives delegated work from the parent process over Node IPC.
 *
 * Invalid messages are rejected with a structured failure response. When an
 * invalid object contains a string requestId, that ID is echoed back so the
 * parent can still correlate the error; otherwise "unknown" is used.
 *
 * Valid requests are handed to handleRequest() without awaiting inside the event
 * callback because EventEmitter does not consume returned promises.
 */
process.on(
  "message",
  (
    message: unknown,
  ) => {
    // Reject malformed IPC before touching nested fields or starting any model
    // work.
    if (
      !isWorkerRequest(
        message,
      )
    ) {
      const response:
        SubAgentWorkerFailure = {
        type:
          "result",
        requestId:
          isRecord(message) &&
          typeof message.requestId ===
            "string"
            ? message.requestId
            : "unknown",
        success:
          false,
        error:
          "The sub-agent worker received an invalid request.",
        workerPid:
          process.pid,
      };

      sendResponse(response);
      return;
    }

    // Explicitly discard the promise here; handleRequest converts expected
    // execution failures into IPC responses itself.
    void handleRequest(
      message,
    );
  },
);
