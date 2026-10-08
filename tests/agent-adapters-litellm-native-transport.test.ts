import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  createLiteLLMNativeCompletionClient,
} from "../src/agent/adapters/litellm-client.ts";

import {
  resolveNativeTransport,
} from "../src/agent/strategy-selection.ts";

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

function requestFor(
  model: string,
): NativeCompletionRequest {
  return {
    model,
    systemPrompt: "system prompt",
    tools: [],
    turns: [
      {
        role: "user",
        content: "hi",
      },
      {
        role: "assistant",
        content: null,
        toolCalls: [
          {
            id: "call_1",
            name: "read_file",
            argumentsJson: '{"path":"a.txt"}',
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "call_1",
        content: '{"status":"succeeded","postcondition_verified":false,"output":"hello"}',
      },
    ],
    parallelToolCalls: false,
  };
}

function sse(
  lines: unknown[],
): Response {
  const encoder = new TextEncoder();

  return new Response(
    new ReadableStream({
      start(controller) {
        for (const line of lines) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify(line)}\n\n`,
            ),
          );
        }

        controller.enqueue(
          encoder.encode(
            "data: [DONE]\n\n",
          ),
        );
        controller.close();
      },
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
      },
    },
  );
}

describe(
  "agent/adapters/litellm-client.ts native transport selection",
  () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it(
      "streams requests for a model resolved to streaming, preserving native history on the wire",
      async () => {
        const fetchMock = vi.fn(
          async () =>
            sse([
              {
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: "call_2",
                          function: {
                            name: "read_",
                            arguments: '{"path":',
                          },
                        },
                      ],
                    },
                  },
                ],
              },
              {
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          function: {
                            name: "file",
                            arguments: '"b.txt"}',
                          },
                        },
                      ],
                    },
                    finish_reason: "tool_calls",
                  },
                ],
              },
            ]),
        );

        vi.stubGlobal(
          "fetch",
          fetchMock,
        );

        const client =
          createLiteLLMNativeCompletionClient(
            testConfig,
            resolveNativeTransport,
          );

        const result =
          await client.complete(
            requestFor(
              "gemma4-e4b-sky",
            ),
          );

        expect(result).toEqual({
          content: null,
          toolCalls: [
            {
              id: "call_2",
              name: "read_file",
              argumentsJson: '{"path":"b.txt"}',
            },
          ],
        });

        const body =
          JSON.parse(
            String(
              (
                fetchMock.mock.calls[0] as unknown as [
                  string,
                  RequestInit,
                ]
              )[1].body,
            ),
          );

        expect(body.stream).toBe(true);
        expect(body).not.toHaveProperty(
          "parallel_tool_calls",
        );
        expect(body).not.toHaveProperty(
          "tool_choice",
        );

        // Native structure reaches the wire unchanged: assistant tool_calls
        // with the original ID and arguments, then the matching tool message.
        expect(body.messages.slice(2)).toEqual([
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: "read_file",
                  arguments: '{"path":"a.txt"}',
                },
              },
            ],
          },
          {
            role: "tool",
            tool_call_id: "call_1",
            content: '{"status":"succeeded","postcondition_verified":false,"output":"hello"}',
          },
        ]);
      },
    );

    it(
      "passes stream assembly issues through to the strategy",
      async () => {
        vi.stubGlobal(
          "fetch",
          vi.fn(async () =>
            sse([
              {
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: "call_x",
                          function: {
                            arguments: "{}",
                          },
                        },
                      ],
                    },
                  },
                ],
              },
            ]),
          ),
        );

        const result =
          await createLiteLLMNativeCompletionClient(
            testConfig,
            () => "streaming",
          ).complete(
            requestFor("m"),
          );

        expect(result.toolCalls).toEqual([]);
        expect(result.protocolIssues).toHaveLength(1);
      },
    );

    it(
      "keeps the non-streaming request for any model not configured to stream, and by default",
      async () => {
        const fetchMock = vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                choices: [
                  {
                    message: {
                      role: "assistant",
                      content: "ok",
                    },
                  },
                ],
              }),
              {
                status: 200,
                headers: {
                  "Content-Type": "application/json",
                },
              },
            ),
        );

        vi.stubGlobal(
          "fetch",
          fetchMock,
        );

        await createLiteLLMNativeCompletionClient(
          testConfig,
          resolveNativeTransport,
        ).complete(
          requestFor(
            "some-unlisted-model",
          ),
        );

        await createLiteLLMNativeCompletionClient(
          testConfig,
        ).complete(
          requestFor(
            "gemma4-e4b-sky",
          ),
        );

        for (
          const callArgs of fetchMock.mock.calls
        ) {
          const body =
            JSON.parse(
              String(
                (
                  callArgs as unknown as [
                    string,
                    RequestInit,
                  ]
                )[1].body,
              ),
            );

          expect(body.stream).toBe(false);
          expect(body).not.toHaveProperty(
            "parallel_tool_calls",
          );
          expect(body).not.toHaveProperty(
            "tool_choice",
          );
        }
      },
    );
  },
);
