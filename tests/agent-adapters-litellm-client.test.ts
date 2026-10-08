import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  createLiteLLMNativeCompletionClient,
  createLiteLLMTextCompletionClient,
} from "../src/agent/adapters/litellm-client.ts";

import type {
  NativeCompletionRequest,
} from "../src/agent/model-client.ts";

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

function jsonResponse(
  body: unknown,
): Response {
  return new Response(
    JSON.stringify(body),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    },
  );
}

function streamingTextResponse(
  text: string,
): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  content: text,
                },
              },
            ],
          })}\n\n`,
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

describe(
  "agent/adapters/litellm-client.ts createLiteLLMTextCompletionClient",
  () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it(
      "sends the system prompt and converted turns, and returns the accumulated text",
      async () => {
        const fetchMock = vi.fn(
          async () =>
            streamingTextResponse(
              "the answer",
            ),
        );

        vi.stubGlobal(
          "fetch",
          fetchMock,
        );

        const client =
          createLiteLLMTextCompletionClient(
            testConfig,
          );

        const result = await client.complete(
          "test-model",
          "system prompt",
          [
            {
              role: "user",
              content: "hello",
            },
            {
              role: "assistant",
              content: "hi",
            },
          ],
        );

        expect(result).toBe(
          "the answer",
        );

        const requestBody = JSON.parse(
          String(
            fetchMock.mock.calls[0]?.[1]?.body,
          ),
        );

        expect(requestBody.messages).toEqual([
          {
            role: "system",
            content: "system prompt",
          },
          {
            role: "user",
            content: "hello",
          },
          {
            role: "assistant",
            content: "hi",
          },
        ]);
      },
    );

    it(
      "requests JSON mode when options.jsonMode is set",
      async () => {
        const fetchMock = vi.fn(
          async () =>
            streamingTextResponse(
              "{}",
            ),
        );

        vi.stubGlobal(
          "fetch",
          fetchMock,
        );

        const client =
          createLiteLLMTextCompletionClient(
            testConfig,
          );

        await client.complete(
          "test-model",
          "system prompt",
          [],
          {
            jsonMode: true,
          },
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
      "forwards streamed fragments to an optional onContent callback",
      async () => {
        vi.stubGlobal(
          "fetch",
          vi.fn(
            async () =>
              streamingTextResponse(
                "fragment",
              ),
          ),
        );

        const forwarded: string[] = [];

        const client =
          createLiteLLMTextCompletionClient(
            testConfig,
            (content) => {
              forwarded.push(content);
            },
          );

        await client.complete(
          "test-model",
          "system prompt",
          [],
        );

        expect(forwarded).toEqual([
          "fragment",
        ]);
      },
    );
  },
);

describe(
  "agent/adapters/litellm-client.ts createLiteLLMNativeCompletionClient",
  () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it(
      "translates canonical tools and conversation turns into the wire request, without sending parallel_tool_calls or tool_choice",
      async () => {
        const fetchMock = vi.fn(
          async () =>
            jsonResponse({
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: "done",
                  },
                },
              ],
            }),
        );

        vi.stubGlobal(
          "fetch",
          fetchMock,
        );

        const client =
          createLiteLLMNativeCompletionClient(
            testConfig,
          );

        const request: NativeCompletionRequest = {
          model: "test-model",
          systemPrompt: "system prompt",
          tools: [
            {
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
              examples: [],
              permissionCategory: "write-file",
            },
          ],
          turns: [
            {
              role: "user",
              content: "please write a file",
            },
            {
              role: "assistant",
              content: null,
              toolCalls: [
                {
                  id: "call-1",
                  name: "write_file",
                  argumentsJson: '{"path":"a.txt"}',
                },
              ],
            },
            {
              role: "tool",
              toolCallId: "call-1",
              content: "Result: succeeded\nWrote a.txt",
            },
          ],
          parallelToolCalls: false,
        };

        await client.complete(
          request,
        );

        const requestBody = JSON.parse(
          String(
            fetchMock.mock.calls[0]?.[1]?.body,
          ),
        );

        expect(requestBody.tools).toEqual([
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
        ]);

        // NativeCompletionRequest.parallelToolCalls is Sky Code's internal
        // intent only; it is never put on the wire.
        expect(requestBody).not.toHaveProperty(
          "parallel_tool_calls",
        );

        expect(requestBody).not.toHaveProperty(
          "tool_choice",
        );

        expect(requestBody.messages[0]).toEqual({
          role: "system",
          content: "system prompt",
        });

        expect(requestBody.messages[1]).toEqual({
          role: "user",
          content: "please write a file",
        });

        expect(requestBody.messages[2]).toEqual({
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: {
                name: "write_file",
                arguments: '{"path":"a.txt"}',
              },
            },
          ],
        });

        expect(requestBody.messages[3]).toEqual({
          role: "tool",
          tool_call_id: "call-1",
          content: "Result: succeeded\nWrote a.txt",
        });
      },
    );

    it(
      "translates the wire response's tool calls back into NativeToolCallRequest values",
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
                          id: "call-9",
                          type: "function",
                          function: {
                            name: "write_file",
                            arguments: '{"path":"z.txt"}',
                          },
                        },
                      ],
                    },
                  },
                ],
              }),
          ),
        );

        const client =
          createLiteLLMNativeCompletionClient(
            testConfig,
          );

        const result = await client.complete({
          model: "test-model",
          systemPrompt: "system prompt",
          tools: [],
          turns: [],
          parallelToolCalls: false,
        });

        expect(result).toEqual({
          content: null,
          toolCalls: [
            {
              id: "call-9",
              name: "write_file",
              argumentsJson: '{"path":"z.txt"}',
            },
          ],
        });
      },
    );
  },
);
