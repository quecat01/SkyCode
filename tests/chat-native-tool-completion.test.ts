import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  requestNativeToolCompletion,
  streamChatCompletion,
  type ChatToolDefinition,
  type NativeChatMessage,
} from "../src/chat.ts";

import type {
  AppConfig,
} from "../src/config.ts";

const testConfig: AppConfig = {
  apiUrl: "http://litellm.test/v1",
  apiKey: "temporary-test-key",
  defaultModel: "test-model",
  defaultPermissionMode: "default",
  compactionThreshold: 6_000,
  compactionStrategy: "summarise",
  compactionWindowSize: 20,
  mcpServers: [],
  pluginDirs: [],
};

const TOOLS: ChatToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Writes a file.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
          },
        },
        required: [
          "path",
        ],
      },
    },
  },
];

function jsonResponse(
  body: unknown,
  status = 200,
): Response {
  return new Response(
    JSON.stringify(body),
    {
      status,
      headers: {
        "Content-Type": "application/json",
      },
    },
  );
}

describe(
  "chat.ts requestNativeToolCompletion",
  () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it(
      "sends a non-streaming request carrying tools but neither tool_choice nor parallel_tool_calls",
      async () => {
        const fetchMock = vi.fn(
          async () =>
            jsonResponse({
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: "All set.",
                  },
                },
              ],
            }),
        );

        vi.stubGlobal(
          "fetch",
          fetchMock,
        );

        const messages: NativeChatMessage[] = [
          {
            role: "user",
            content: "please write a file",
          },
        ];

        await requestNativeToolCompletion(
          testConfig,
          "test-model",
          "system prompt",
          messages,
          TOOLS,
        );

        expect(fetchMock).toHaveBeenCalledOnce();

        const requestOptions =
          fetchMock.mock.calls[0]?.[1];

        expect(requestOptions?.method).toBe(
          "POST",
        );

        const requestBody = JSON.parse(
          String(requestOptions?.body),
        );

        expect(requestBody.model).toBe(
          "test-model",
        );

        expect(requestBody.stream).toBe(
          false,
        );

        expect(requestBody.messages[0]).toEqual({
          role: "system",
          content: "system prompt",
        });

        expect(requestBody.messages[1]).toEqual({
          role: "user",
          content: "please write a file",
        });

        expect(requestBody.tools).toEqual(
          TOOLS,
        );

        // Some gateway backends reject these outright (LiteLLM's ollama_chat
        // rejects parallel_tool_calls with HTTP 400), and tool_choice "auto"
        // is already the default whenever tools are sent.
        expect(requestBody).not.toHaveProperty(
          "tool_choice",
        );

        expect(requestBody).not.toHaveProperty(
          "parallel_tool_calls",
        );

        expect(
          Object.keys(requestBody).sort(),
        ).toEqual([
          "messages",
          "model",
          "stream",
          "tools",
        ]);
      },
    );

    it(
      "returns a single valid tool call from the response",
      async () => {
        vi.stubGlobal(
          "fetch",
          vi.fn(
            async () =>
              jsonResponse({
                choices: [
                  {
                    message: {
                      role: "assistant",
                      content: null,
                      tool_calls: [
                        {
                          id: "call-1",
                          type: "function",
                          function: {
                            name: "write_file",
                            arguments: '{"path":"notes.md"}',
                          },
                        },
                      ],
                    },
                  },
                ],
              }),
          ),
        );

        const result =
          await requestNativeToolCompletion(
            testConfig,
            "test-model",
            "system prompt",
            [],
            TOOLS,
          );

        expect(result).toEqual({
          content: null,
          toolCalls: [
            {
              id: "call-1",
              type: "function",
              function: {
                name: "write_file",
                arguments: '{"path":"notes.md"}',
              },
            },
          ],
        });
      },
    );

    it(
      "returns plain content with no tool calls when the response has none",
      async () => {
        vi.stubGlobal(
          "fetch",
          vi.fn(
            async () =>
              jsonResponse({
                choices: [
                  {
                    message: {
                      role: "assistant",
                      content: "Nothing to do here.",
                    },
                  },
                ],
              }),
          ),
        );

        const result =
          await requestNativeToolCompletion(
            testConfig,
            "test-model",
            "system prompt",
            [],
            TOOLS,
          );

        expect(result).toEqual({
          content: "Nothing to do here.",
          toolCalls: [],
        });
      },
    );

    it(
      "skips a malformed individual tool_calls entry while keeping the valid ones",
      async () => {
        vi.stubGlobal(
          "fetch",
          vi.fn(
            async () =>
              jsonResponse({
                choices: [
                  {
                    message: {
                      role: "assistant",
                      content: null,
                      tool_calls: [
                        {
                          id: "call-1",
                          type: "function",
                          function: {
                            name: "write_file",
                            arguments: "{}",
                          },
                        },
                        {
                          id: "call-2",
                          type: "function",
                          function: {
                            // missing "name" makes this entry malformed
                            arguments: "{}",
                          },
                        },
                      ],
                    },
                  },
                ],
              }),
          ),
        );

        const result =
          await requestNativeToolCompletion(
            testConfig,
            "test-model",
            "system prompt",
            [],
            TOOLS,
          );

        expect(result.toolCalls).toEqual([
          {
            id: "call-1",
            type: "function",
            function: {
              name: "write_file",
              arguments: "{}",
            },
          },
        ]);
      },
    );

    it(
      "throws a clear error on an unsuccessful HTTP response",
      async () => {
        vi.stubGlobal(
          "fetch",
          vi.fn(
            async () =>
              new Response(
                "internal error",
                {
                  status: 500,
                  statusText: "Internal Server Error",
                },
              ),
          ),
        );

        await expect(
          requestNativeToolCompletion(
            testConfig,
            "test-model",
            "system prompt",
            [],
            TOOLS,
          ),
        ).rejects.toThrow(
          /LiteLLM native tool-calling request failed: HTTP 500/,
        );
      },
    );

    it(
      "throws a clear error when the response has no choices",
      async () => {
        vi.stubGlobal(
          "fetch",
          vi.fn(
            async () =>
              jsonResponse({
                choices: [],
              }),
          ),
        );

        await expect(
          requestNativeToolCompletion(
            testConfig,
            "test-model",
            "system prompt",
            [],
            TOOLS,
          ),
        ).rejects.toThrow(
          /did not contain any choices/,
        );
      },
    );
  },
);

describe(
  "chat.ts streamChatCompletion responseFormat",
  () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    function streamingResponse(): Response {
      const encoder = new TextEncoder();

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
            ),
          );

          controller.enqueue(
            encoder.encode(
              "data: [DONE]\n\n",
            ),
          );

          controller.close();
        },
      });

      return new Response(
        stream,
        {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
          },
        },
      );
    }

    it(
      "includes response_format when jsonMode is requested",
      async () => {
        const fetchMock = vi.fn(
          async () => streamingResponse(),
        );

        vi.stubGlobal(
          "fetch",
          fetchMock,
        );

        await streamChatCompletion(
          testConfig,
          "test-model",
          [],
          () => {},
          "system prompt",
          "json_object",
        );

        const requestBody = JSON.parse(
          String(
            fetchMock.mock.calls[0]?.[1]?.body,
          ),
        );

        expect(requestBody.response_format).toEqual({
          type: "json_object",
        });
      },
    );

    it(
      "omits response_format entirely for existing callers that do not request it",
      async () => {
        const fetchMock = vi.fn(
          async () => streamingResponse(),
        );

        vi.stubGlobal(
          "fetch",
          fetchMock,
        );

        await streamChatCompletion(
          testConfig,
          "test-model",
          [],
          () => {},
          "system prompt",
        );

        const requestBody = JSON.parse(
          String(
            fetchMock.mock.calls[0]?.[1]?.body,
          ),
        );

        expect(
          Object.prototype.hasOwnProperty.call(
            requestBody,
            "response_format",
          ),
        ).toBe(
          false,
        );
      },
    );
  },
);
