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

let handlingRequest =
  false;

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

  const model =
    request.agent.model ??
    request.config
      .defaultModel;

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
    mcpServers: [],
    pluginDirs: [],
  };

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

process.on(
  "message",
  (
    message: unknown,
  ) => {
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

    void handleRequest(
      message,
    );
  },
);
