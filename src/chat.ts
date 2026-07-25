import type {
  AppConfig,
} from "./config.js";

import {
  SKY_CODE_SYSTEM_PROMPT,
} from "./tools.js";

export type ChatRole =
  | "user"
  | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

interface ModelListResponse {
  data: Array<{
    id: string;
  }>;
}

function removeTrailingSlashes(
  value: string,
): string {
  return value.replace(
    /\/+$/,
    "",
  );
}

async function readErrorBody(
  response: Response,
): Promise<string> {
  try {
    const body =
      await response.text();

    if (body.trim() !== "") {
      return body;
    }
  } catch {
    // Ignore body-reading errors and use the HTTP status below.
  }

  return `${response.status} ${response.statusText}`.trim();
}

function extractStreamContent(
  value: unknown,
): string | null {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    return null;
  }

  const record =
    value as Record<
      string,
      unknown
    >;

  const choices =
    record.choices;

  if (
    !Array.isArray(choices) ||
    choices.length === 0
  ) {
    return null;
  }

  const firstChoice =
    choices[0];

  if (
    typeof firstChoice !==
      "object" ||
    firstChoice === null ||
    Array.isArray(firstChoice)
  ) {
    return null;
  }

  const choiceRecord =
    firstChoice as Record<
      string,
      unknown
    >;

  const delta =
    choiceRecord.delta;

  if (
    typeof delta !== "object" ||
    delta === null ||
    Array.isArray(delta)
  ) {
    return null;
  }

  const deltaRecord =
    delta as Record<
      string,
      unknown
    >;

  const content =
    deltaRecord.content;

  return typeof content ===
    "string"
    ? content
    : null;
}

export async function fetchAvailableModels(
  config: AppConfig,
): Promise<string[]> {
  const apiUrl =
    removeTrailingSlashes(
      config.apiUrl,
    );

  const response =
    await fetch(
      `${apiUrl}/models`,
      {
        method: "GET",
        headers: {
          Authorization:
            `Bearer ${config.apiKey}`,
          Accept:
            "application/json",
        },
      },
    );

  if (!response.ok) {
    const errorBody =
      await readErrorBody(
        response,
      );

    throw new Error(
      `Unable to retrieve LiteLLM models: HTTP ${response.status}: ${errorBody}`,
    );
  }

  const payload: unknown =
    await response.json();

  if (
    typeof payload !==
      "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    throw new Error(
      "LiteLLM returned an invalid model-list response",
    );
  }

  const modelList =
    payload as Partial<
      ModelListResponse
    >;

  if (
    !Array.isArray(
      modelList.data,
    )
  ) {
    throw new Error(
      'LiteLLM model-list response does not contain a "data" array',
    );
  }

  const models =
    modelList.data
      .map((entry) => {
        if (
          typeof entry ===
            "object" &&
          entry !== null &&
          !Array.isArray(
            entry,
          ) &&
          typeof (
            entry as Record<
              string,
              unknown
            >
          ).id === "string"
        ) {
          return (
            entry as Record<
              string,
              unknown
            >
          ).id as string;
        }

        return null;
      })
      .filter(
        (
          model,
        ): model is string =>
          model !== null,
      );

  return [
    ...new Set(models),
  ];
}

export async function streamChatCompletion(
  config: AppConfig,
  model: string,
  messages: ChatMessage[],
  onContent:
    (content: string) => void,
  systemPrompt: string =
    SKY_CODE_SYSTEM_PROMPT,
): Promise<string> {
  const apiUrl =
    removeTrailingSlashes(
      config.apiUrl,
    );

  const response =
    await fetch(
      `${apiUrl}/chat/completions`,
      {
        method: "POST",
        headers: {
          Authorization:
            `Bearer ${config.apiKey}`,
          "Content-Type":
            "application/json",
          Accept:
            "text/event-stream",
        },
        body: JSON.stringify({
          model,
          stream: true,
          messages: [
            {
              role: "system",
              content:
                systemPrompt,
            },
            ...messages,
          ],
        }),
      },
    );

  if (!response.ok) {
    const errorBody =
      await readErrorBody(
        response,
      );

    throw new Error(
      `LiteLLM chat request failed: HTTP ${response.status}: ${errorBody}`,
    );
  }

  if (!response.body) {
    throw new Error(
      "LiteLLM returned a streaming response without a body",
    );
  }

  const reader =
    response.body.getReader();

  const decoder =
    new TextDecoder();

  let buffer = "";
  let fullResponse = "";
  let streamFinished = false;

  function processLine(
    line: string,
  ): void {
    const trimmedLine =
      line.trim();

    if (
      trimmedLine === "" ||
      trimmedLine.startsWith(
        ":",
      ) ||
      !trimmedLine.startsWith(
        "data:",
      )
    ) {
      return;
    }

    const data =
      trimmedLine
        .slice(
          "data:".length,
        )
        .trim();

    if (data === "[DONE]") {
      streamFinished = true;
      return;
    }

    let parsed: unknown;

    try {
      parsed =
        JSON.parse(data);
    } catch (error) {
      throw new Error(
        `LiteLLM returned invalid streaming JSON: ${
          error instanceof Error
            ? error.message
            : String(error)
        }`,
      );
    }

    const content =
      extractStreamContent(
        parsed,
      );

    if (
      content !== null &&
      content !== ""
    ) {
      fullResponse +=
        content;

      onContent(content);
    }
  }

  while (!streamFinished) {
    const {
      done,
      value,
    } = await reader.read();

    if (done) {
      break;
    }

    buffer +=
      decoder.decode(
        value,
        {
          stream: true,
        },
      );

    const lines =
      buffer.split(
        /\r?\n/,
      );

    buffer =
      lines.pop() ?? "";

    for (
      const line of lines
    ) {
      processLine(line);

      if (streamFinished) {
        break;
      }
    }
  }

  buffer += decoder.decode();

  if (
    !streamFinished &&
    buffer.trim() !== ""
  ) {
    processLine(buffer);
  }

  return fullResponse;
}
