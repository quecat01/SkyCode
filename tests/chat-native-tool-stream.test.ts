import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  streamNativeToolCompletion,
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
      name: "create_docx",
      description: "Creates a DOCX file.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
];

/**
 * Builds an SSE response whose body is delivered as the given raw byte
 * pieces, so tests control exactly where network chunk boundaries fall.
 */
function sseResponse(
  pieces: string[],
): Response {
  const encoder = new TextEncoder();

  return new Response(
    new ReadableStream({
      start(controller) {
        for (const piece of pieces) {
          controller.enqueue(
            encoder.encode(piece),
          );
        }

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

function dataLine(
  value: unknown,
): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

describe(
  "chat.ts streamNativeToolCompletion",
  () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it(
      "sends a streamed request carrying tools, tool_choice auto, and parallel_tool_calls false",
      async () => {
        const fetchMock = vi.fn(
          async () =>
            sseResponse([
              dataLine({
                choices: [
                  {
                    delta: {
                      content: "Done.",
                    },
                  },
                ],
              }),
              "data: [DONE]\n\n",
            ]),
        );

        vi.stubGlobal(
          "fetch",
          fetchMock,
        );

        const messages: NativeChatMessage[] = [
          {
            role: "user",
            content: "make a report",
          },
        ];

        await streamNativeToolCompletion(
          testConfig,
          "gemma4-e4b-sky",
          "system prompt",
          messages,
          TOOLS,
          false,
        );

        const [url, init] =
          fetchMock.mock.calls[0] as unknown as [
            string,
            RequestInit,
          ];

        expect(url).toBe(
          "http://litellm.test/v1/chat/completions",
        );

        const body =
          JSON.parse(
            String(init.body),
          );

        expect(body).toMatchObject({
          model: "gemma4-e4b-sky",
          stream: true,
          tools: TOOLS,
          tool_choice: "auto",
          parallel_tool_calls: false,
        });

        expect(body.messages[0]).toEqual({
          role: "system",
          content: "system prompt",
        });

        expect(body.messages.slice(1)).toEqual(
          messages,
        );
      },
    );

    it(
      "assembles a tool call whose SSE lines are split mid-line across network chunks",
      async () => {
        const first =
          dataLine({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_77",
                      type: "function",
                      function: {
                        name: "create_docx",
                        arguments: '{"path":"r.docx",',
                      },
                    },
                  ],
                },
              },
            ],
          });

        const second =
          dataLine({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      function: {
                        arguments: '"content":"Hi"}',
                      },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          });

        // Split each SSE line at an arbitrary byte position.
        vi.stubGlobal(
          "fetch",
          vi.fn(async () =>
            sseResponse([
              first.slice(0, 17),
              first.slice(17) + second.slice(0, 40),
              second.slice(40),
              "data: [DO",
              "NE]\n\n",
            ]),
          ),
        );

        const result =
          await streamNativeToolCompletion(
            testConfig,
            "m",
            "s",
            [],
            TOOLS,
            false,
          );

        expect(result.content).toBeNull();
        expect(result.toolCalls).toEqual([
          {
            id: "call_77",
            type: "function",
            function: {
              name: "create_docx",
              arguments:
                '{"path":"r.docx","content":"Hi"}',
            },
          },
        ]);
        expect(result.protocolIssues).toEqual([]);
      },
    );

    it(
      "returns assembly protocol issues instead of a usable call when a streamed call is incomplete",
      async () => {
        vi.stubGlobal(
          "fetch",
          vi.fn(async () =>
            sseResponse([
              dataLine({
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: "call_1",
                          function: {
                            arguments: "{}",
                          },
                        },
                      ],
                    },
                  },
                ],
              }),
              "data: [DONE]\n\n",
            ]),
          ),
        );

        const result =
          await streamNativeToolCompletion(
            testConfig,
            "m",
            "s",
            [],
            TOOLS,
            false,
          );

        expect(result.toolCalls).toEqual([]);
        expect(result.protocolIssues).toHaveLength(1);
      },
    );

    it(
      "throws on an unsuccessful HTTP response",
      async () => {
        vi.stubGlobal(
          "fetch",
          vi.fn(async () =>
            new Response(
              "upstream unavailable",
              {
                status: 503,
              },
            ),
          ),
        );

        await expect(
          streamNativeToolCompletion(
            testConfig,
            "m",
            "s",
            [],
            TOOLS,
            false,
          ),
        ).rejects.toThrow(
          "HTTP 503",
        );
      },
    );
  },
);
