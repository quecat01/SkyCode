import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  requestNativeToolCompletion,
  streamNativeToolCompletion,
  type NativeChatMessage,
} from "../src/chat.ts";

import type {
  AppConfig,
} from "../src/config.ts";

import {
  redactSecrets,
  summarizeNativeRequest,
} from "../src/native-diagnostics.ts";

import {
  runAgentLoop,
} from "../src/agent/loop.ts";

import {
  NativeStrategy,
} from "../src/agent/strategies/native.ts";

import type {
  NativeCompletionClient,
  NativeCompletionResult,
} from "../src/agent/model-client.ts";

import type {
  AgentEvent,
} from "../src/agent/types.ts";

/**
 * Tests for the content-free native request/response diagnostics: they must
 * tell an empty provider reply apart from text, reasoning, a gateway error
 * inside the stream, a length cut-off, or a broken history, without ever
 * recording message text, arguments, tool output, reasoning text, or keys,
 * and without changing how any response is handled.
 */

const SECRET_KEY = "sk-live-0123456789abcdef";

const testConfig: AppConfig = {
  apiUrl: "http://litellm.test/v1",
  apiKey: SECRET_KEY,
  defaultModel: "test-model",
  defaultPermissionMode: "default",
  compactionThreshold: 6_000,
  compactionStrategy: "summarise",
  compactionWindowSize: 20,
  mcpServers: [],
  pluginDirs: [],
};

const SYSTEM_PROMPT = "SYSTEM-PROMPT-TEXT";

const DOCX_CONTENT = "PRIVATE-DOCUMENT-BODY";

const TOOL_OUTPUT = "PRIVATE-TOOL-OUTPUT";

/** The canonical history after a recoverable OUTPUT_PATH_EXISTS failure. */
const AFTER_COLLISION: NativeChatMessage[] = [
  {
    role: "user",
    content: "Create a DOCX summary.",
  },
  {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: "call_1",
        type: "function",
        function: {
          name: "create_docx",
          arguments: JSON.stringify({
            path: "output/e2b_project_summary.docx",
            content: DOCX_CONTENT,
          }),
        },
      },
    ],
  },
  {
    role: "tool",
    tool_call_id: "call_1",
    content: JSON.stringify({
      status: "failed",
      output: TOOL_OUTPUT,
      error_code: "OUTPUT_PATH_EXISTS",
      recoverable: true,
      suggested_arguments: {
        path: "output/e2b_project_summary_2.docx",
      },
    }),
  },
];

/** A streamed response made of the given data events. */
function sse(
  events: unknown[],
  withDone = true,
): Response {
  const text =
    events
      .map(
        (event) =>
          `data: ${JSON.stringify(event)}\n\n`,
      )
      .join("") +
    (withDone
      ? "data: [DONE]\n\n"
      : "");

  return new Response(
    text,
    {
      headers: {
        "content-type":
          "text/event-stream",
      },
    },
  );
}

async function streamWith(
  response: Response,
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () => response,
    ),
  );

  return streamNativeToolCompletion(
    testConfig,
    "gemma4-e2b-sky",
    SYSTEM_PROMPT,
    AFTER_COLLISION,
    [],
  );
}

afterEach(
  () => {
    vi.unstubAllGlobals();
  },
);

describe(
  "streamed response diagnostics",
  () => {
    it(
      "reports a stream with only a finish reason as an empty reply from the provider",
      async () => {
        const result =
          await streamWith(
            sse([
              {
                choices: [
                  {
                    index: 0,
                    delta: {
                      role: "assistant",
                    },
                  },
                ],
              },
              {
                choices: [
                  {
                    index: 0,
                    delta: {},
                    finish_reason: "stop",
                  },
                ],
              },
            ]),
          );

        expect(result.content).toBeNull();
        expect(result.toolCalls).toEqual([]);
        expect(
          result.diagnostics!.response,
        ).toBe(
          "response (streaming): finish_reason=stop; chunks=2; choiceless_chunks=0; content_chars=0; reasoning_chars=0; tool_call_parts=0; errors=0; done=true",
        );
      },
    );

    it(
      "counts reasoning text without keeping or reporting it",
      async () => {
        const reasoning =
          "SECRET-REASONING-TEXT";

        const result =
          await streamWith(
            sse([
              {
                choices: [
                  {
                    index: 0,
                    delta: {
                      reasoning_content:
                        reasoning,
                    },
                  },
                ],
              },
              {
                choices: [
                  {
                    index: 0,
                    delta: {
                      reasoning: "abc",
                      thinking: "de",
                    },
                    finish_reason: "stop",
                  },
                ],
              },
            ]),
          );

        // Unchanged handling: reasoning is still not content.
        expect(result.content).toBeNull();
        expect(
          result.diagnostics!.response,
        ).toContain(
          `content_chars=0; reasoning_chars=${reasoning.length + 5};`,
        );
        expect(
          JSON.stringify(
            result.diagnostics,
          ),
        ).not.toContain(
          reasoning,
        );
      },
    );

    it(
      "reports an error the gateway sent inside the stream, with keys masked",
      async () => {
        const result =
          await streamWith(
            sse([
              {
                error: {
                  message:
                    `OllamaException: model runner crashed (Authorization: Bearer ${SECRET_KEY}; api_key=${SECRET_KEY})`,
                },
              },
            ]),
          );

        expect(result.content).toBeNull();

        const line =
          result.diagnostics!.response;

        expect(line).toContain(
          "chunks=1; choiceless_chunks=1;",
        );
        expect(line).toContain(
          "errors=1",
        );
        expect(line).toContain(
          'error="OllamaException: model runner crashed (Authorization: Bearer [redacted]; api_key=[redacted])"',
        );
        expect(line).not.toContain(
          SECRET_KEY,
        );
      },
    );

    it(
      "shows a length cut-off with no tool call, which assembly itself does not flag",
      async () => {
        const result =
          await streamWith(
            sse([
              {
                choices: [
                  {
                    index: 0,
                    delta: {},
                    finish_reason: "length",
                  },
                ],
              },
            ]),
          );

        expect(result.protocolIssues).toEqual([]);
        expect(
          result.diagnostics!.response,
        ).toContain(
          "finish_reason=length;",
        );
      },
    );

    it(
      "reports token usage from a usage chunk, and a stream that ended without its end marker",
      async () => {
        const result =
          await streamWith(
            sse(
              [
                {
                  choices: [
                    {
                      index: 0,
                      delta: {
                        content: "Hi",
                      },
                      finish_reason: "stop",
                    },
                  ],
                },
                {
                  choices: [],
                  usage: {
                    prompt_tokens: 8190,
                    completion_tokens: 1,
                  },
                },
              ],
              false,
            ),
          );

        expect(
          result.diagnostics!.response,
        ).toBe(
          "response (streaming): finish_reason=stop; chunks=2; choiceless_chunks=1; content_chars=2; reasoning_chars=0; tool_call_parts=0; errors=0; prompt_tokens=8190; completion_tokens=1; done=false",
        );
      },
    );

    it(
      "summarizes the canonical history sent after a failed call without its content",
      async () => {
        const result =
          await streamWith(
            sse([]),
          );

        const line =
          result.diagnostics!.request;

        expect(line).toMatch(
          /^request: 4 messages \[system, user, assistant\(call_1 create_docx\), tool\(call_1 failed \d+ chars\)\]; pairing ok; 0 tools; body \d+ chars$/,
        );

        for (
          const privateText of [
            SYSTEM_PROMPT,
            DOCX_CONTENT,
            TOOL_OUTPUT,
            "e2b_project_summary",
            SECRET_KEY,
            "litellm.test",
          ]
        ) {
          expect(
            JSON.stringify(
              result.diagnostics,
            ),
          ).not.toContain(
            privateText,
          );
        }

        expect(
          result.diagnostics!.response,
        ).toBe(
          "response (streaming): finish_reason=none; chunks=0; choiceless_chunks=0; content_chars=0; reasoning_chars=0; tool_call_parts=0; errors=0; done=true",
        );
      },
    );
  },
);

describe(
  "non-streamed response diagnostics",
  () => {
    it(
      "reports finish reason, reasoning size and usage from a complete response",
      async () => {
        vi.stubGlobal(
          "fetch",
          vi.fn(
            async () =>
              new Response(
                JSON.stringify({
                  choices: [
                    {
                      finish_reason: "stop",
                      message: {
                        role: "assistant",
                        content: "",
                        reasoning_content:
                          "1234567",
                      },
                    },
                  ],
                  usage: {
                    prompt_tokens: 900,
                    completion_tokens: 40,
                  },
                }),
              ),
          ),
        );

        const result =
          await requestNativeToolCompletion(
            testConfig,
            "m",
            SYSTEM_PROMPT,
            AFTER_COLLISION,
            [],
          );

        expect(
          result.diagnostics!.response,
        ).toBe(
          "response (non_streaming): finish_reason=stop; content_chars=0; reasoning_chars=7; tool_call_parts=0; errors=0; prompt_tokens=900; completion_tokens=40",
        );
      },
    );
  },
);

describe(
  "request pairing check",
  () => {
    it(
      "reports a call with no tool result and a tool result for no open call",
      () => {
        expect(
          summarizeNativeRequest(
            [
              {
                role: "system",
                content: "s",
              },
              {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "a",
                    function: {
                      name: "read_file",
                    },
                  },
                ],
              },
              {
                role: "user",
                content: "next",
              },
              {
                role: "tool",
                tool_call_id: "b",
                content: "not json",
              },
            ],
            2,
            123,
          ),
        ).toBe(
          "request: 4 messages [system, assistant(a read_file), user, tool(b unparsed 8 chars)]; pairing problems: call a has no tool result; tool result b answers no open call; 2 tools; body 123 chars",
        );
      },
    );

    it(
      "accepts several calls answered in any order before the next message",
      () => {
        expect(
          summarizeNativeRequest(
            [
              {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "a",
                    function: {
                      name: "x",
                    },
                  },
                  {
                    id: "b",
                    function: {
                      name: "y",
                    },
                  },
                ],
              },
              {
                role: "tool",
                tool_call_id: "b",
                content: '{"status":"not_executed"}',
              },
              {
                role: "tool",
                tool_call_id: "a",
                content: '{"status":"not_executed"}',
              },
            ],
            0,
            1,
          ),
        ).toContain(
          "; pairing ok;",
        );
      },
    );
  },
);

describe(
  "redactSecrets",
  () => {
    it(
      "masks bearer tokens, sk- keys and key assignments, leaving other text",
      () => {
        expect(
          redactSecrets(
            'bad request: Bearer abc.def sk-ABCDEF123 {"api_key": "k1"} token=t2 password: p3 model=gemma',
          ),
        ).toBe(
          'bad request: Bearer [redacted] sk-[redacted] {"api_key": "[redacted]"} token=[redacted] password: [redacted] model=gemma',
        );
      },
    );
  },
);

describe(
  "NativeStrategy reporting",
  () => {
    it(
      "reports each exchange as a diagnostic only, and still handles an empty reply exactly as before",
      async () => {
        const empty: NativeCompletionResult = {
          content: null,
          toolCalls: [],
          exchangeDiagnostics: [
            "m request: 2 messages [system, user]; pairing ok; 0 tools; body 10 chars",
            "m response (streaming): finish_reason=stop; chunks=1; choiceless_chunks=0; content_chars=0; reasoning_chars=0; tool_call_parts=0; errors=0; done=true",
          ],
        };

        let calls = 0;

        const client: NativeCompletionClient = {
          async complete() {
            calls += 1;

            return calls < 3
              ? empty
              : {
                  content: "Nothing was created.",
                  toolCalls: [],
                };
          },
        };

        const events: AgentEvent[] = [];

        const outcome =
          await runAgentLoop(
            "Say hello.",
            [],
            new NativeStrategy(
              client,
              "system prompt",
            ),
            [],
            "m",
            {
              async execute() {
                throw new Error(
                  "no tool should run",
                );
              },
            },
            {
              async produce() {
                return "unused";
              },
            },
            (event) => {
              events.push(event);
            },
          );

        // Same as without diagnostics: two corrective retries, then the reply.
        expect(calls).toBe(3);
        expect(outcome).toMatchObject({
          kind: "final_answer",
          text: "Nothing was created.",
        });

        const details =
          events.flatMap(
            (event) =>
              event.type === "protocol_condition"
                ? [event.detail]
                : [],
          );

        expect(
          details.filter(
            (detail) =>
              detail.startsWith(
                "NativeStrategy exchange: m response (streaming): finish_reason=stop;",
              ),
          ),
        ).toHaveLength(2);
        expect(
          details.filter(
            (detail) =>
              detail.startsWith(
                "NativeStrategy exchange: m request:",
              ),
          ),
        ).toHaveLength(2);
      },
    );
  },
);
