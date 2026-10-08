import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  NativeRequestHttpError,
  requestNativeToolCompletion,
  streamNativeToolCompletion,
} from "../src/chat.ts";

import type {
  AppConfig,
} from "../src/config.ts";

import {
  isNativeToolsRejection,
  isNativeToolsUnsupportedError,
  NativeSupportCache,
} from "../src/agent/native-support.ts";

import {
  NativeFirstStrategy,
} from "../src/agent/strategies/native-first.ts";

import {
  NativeStrategy,
} from "../src/agent/strategies/native.ts";

import {
  PromptedStrategy,
} from "../src/agent/strategies/prompted.ts";

import {
  runAgentLoop,
} from "../src/agent/loop.ts";

import {
  BUILTIN_TOOL_DEFINITIONS,
} from "../src/agent/tool-schema.ts";

import type {
  NativeCompletionClient,
  NativeCompletionResult,
  TextCompletionClient,
} from "../src/agent/model-client.ts";

import type {
  AgentContext,
  AgentEvent,
  AgentToolResult,
  ToolDefinition,
  ToolExecutor,
} from "../src/agent/types.ts";

/**
 * Tests for the protocol-based Native -> Prompted fallback: what does and
 * does not count as an endpoint refusing native tool calling, how the
 * finding is remembered for the session, and that ordinary model or tool
 * behavior never causes a downgrade.
 */

const ENDPOINT = "http://litellm.test/v1";
const MODEL = "some-model";

const TOOLS: ToolDefinition[] = [
  ...BUILTIN_TOOL_DEFINITIONS,
];

const DOCX_ARGS = {
  path: "status.docx",
  content: "# Status\n\nOn track.",
};

const PDF_ARGS = {
  path: "summary.pdf",
  content: "# Summary",
};

/** LiteLLM's real rejection when the backend has no tool support. */
const LITELLM_TOOLS_REJECTED =
  '{"error":{"message":"litellm.UnsupportedParamsError: some_backend does not support parameters: [\'tools\'], for model=some-model. To drop these, set `litellm.drop_params=True`","code":"400"}}';

/**
 * LiteLLM's real rejection from the first native acceptance test
 * (738045e): one optional field, not tool calling itself.
 */
const LITELLM_PARALLEL_REJECTED =
  '{"error":{"message":"litellm.UnsupportedParamsError: ollama_chat does not support parameters: [\'parallel_tool_calls\'], for model=gemma4-e4b-sky. To drop these, set `litellm.drop_params=True` or for proxy:\\n\\n`litellm_settings:\\n drop_params: true`\\n. \\n If you want to use these params dynamically send allowed_openai_params=[\'parallel_tool_calls\'] in your request.. Received Model Group=gemma4-e4b-sky\\nAvailable Model Group Fallbacks=None","type":"None","param":null,"code":"400"}}';

const CONTEXT: AgentContext = {
  priorTurns: [],
  goal: "Create a project status DOCX report for the Q3 launch.",
  history: [],
};

/**
 * A native client whose every call returns, or throws, the next scripted
 * entry; records how many times it was called.
 */
function scriptedNativeClient(
  script: (NativeCompletionResult | Error)[],
): NativeCompletionClient & {
  calls: number;
} {
  const client = {
    calls: 0,
    async complete() {
      const next =
        script[client.calls];

      client.calls += 1;

      if (next instanceof Error) {
        throw next;
      }

      if (!next) {
        throw new Error(
          "scriptedNativeClient ran out of scripted results",
        );
      }

      return next;
    },
  };

  return client;
}

/**
 * A prompted-strategy text client returning scripted selections, recording
 * the turns of every call.
 */
function scriptedTextClient(
  responses: string[],
): TextCompletionClient & {
  calls: string[];
} {
  const calls: string[] = [];

  return {
    calls,
    async complete(
      _model,
      _systemPrompt,
      turns,
    ) {
      calls.push(
        JSON.stringify(turns),
      );

      const next =
        responses[calls.length - 1];

      if (next === undefined) {
        throw new Error(
          "scriptedTextClient ran out of scripted responses",
        );
      }

      return next;
    },
  };
}

function nativeCall(
  id: string,
  name: string,
  args: unknown,
): NativeCompletionResult {
  return {
    content: null,
    toolCalls: [
      {
        id,
        name,
        argumentsJson:
          JSON.stringify(args),
      },
    ],
  };
}

function nativeText(
  content: string,
): NativeCompletionResult {
  return {
    content,
    toolCalls: [],
  };
}

function httpError(
  status: number,
  body: string,
): NativeRequestHttpError {
  return new NativeRequestHttpError(
    status,
    body,
  );
}

/** Builds the production composition: native first, prompted fallback. */
function nativeFirst(
  nativeClient: NativeCompletionClient,
  textClient: TextCompletionClient,
  cache = new NativeSupportCache(),
  endpoint = ENDPOINT,
) {
  return {
    cache,
    strategy:
      new NativeFirstStrategy(
        new NativeStrategy(
          nativeClient,
          "native system prompt",
        ),
        new PromptedStrategy(
          textClient,
        ),
        cache,
        endpoint,
      ),
  };
}

function scriptedExecutor(
  results: AgentToolResult[],
): ToolExecutor & {
  calls: string[];
} {
  const calls: string[] = [];

  return {
    calls,
    async execute(tool) {
      calls.push(tool);

      const next =
        results[calls.length - 1];

      if (!next) {
        throw new Error(
          "scriptedExecutor ran out of scripted results",
        );
      }

      return next;
    },
  };
}

describe(
  "agent/native-support.ts isNativeToolsRejection",
  () => {
    it.each([
      [
        "LiteLLM listing tools as unsupported",
        400,
        LITELLM_TOOLS_REJECTED,
      ],
      [
        "LiteLLM listing functions as unsupported",
        400,
        "litellm.UnsupportedParamsError: x does not support parameters: ['functions']",
      ],
      [
        "Ollama refusing tools",
        400,
        '{"error":"registry.ollama.ai/library/tinymodel:latest does not support tools"}',
      ],
      [
        "a generic tool-calling refusal",
        400,
        '{"error":{"message":"Tool calling is not supported for this model."}}',
      ],
      [
        "a function-calling refusal on 422",
        422,
        '{"detail":"function calling is not supported"}',
      ],
      [
        "vLLM started without tool-call parsing",
        400,
        '{"message":"\\"auto\\" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set"}',
      ],
    ])(
      "accepts %s",
      (_label, status, body) => {
        expect(
          isNativeToolsRejection(
            status,
            body,
          ),
        ).toBe(true);
      },
    );

    it(
      "rejects the parallel_tool_calls UnsupportedParamsError from the first acceptance test",
      () => {
        expect(
          isNativeToolsRejection(
            400,
            LITELLM_PARALLEL_REJECTED,
          ),
        ).toBe(false);
      },
    );

    it.each([
      "litellm.UnsupportedParamsError: x does not support parameters: ['tool_choice']",
      "parallel_tool_calls is not supported for this model",
      "response_format is not supported",
      '{"error":{"message":"Invalid value for messages[2].content"}}',
      "Bad request",
    ])(
      "rejects an unrelated 400: %s",
      (body) => {
        expect(
          isNativeToolsRejection(
            400,
            body,
          ),
        ).toBe(false);
      },
    );

    it.each([
      401,
      403,
      404,
      429,
      500,
      502,
      503,
    ])(
      "never accepts HTTP %i, even with a tools-unsupported body",
      (status) => {
        expect(
          isNativeToolsRejection(
            status,
            LITELLM_TOOLS_REJECTED,
          ),
        ).toBe(false);
      },
    );

    it(
      "only recognizes failed native HTTP requests as rejections, never network or timeout errors",
      () => {
        expect(
          isNativeToolsUnsupportedError(
            httpError(
              400,
              LITELLM_TOOLS_REJECTED,
            ),
          ),
        ).toBe(true);

        expect(
          isNativeToolsUnsupportedError(
            new TypeError("fetch failed"),
          ),
        ).toBe(false);

        const timeout =
          new Error("The operation was aborted due to timeout");
        timeout.name = "TimeoutError";

        expect(
          isNativeToolsUnsupportedError(
            timeout,
          ),
        ).toBe(false);

        expect(
          isNativeToolsUnsupportedError(
            new Error(
              `LiteLLM native tool-calling request failed: HTTP 400: ${LITELLM_TOOLS_REJECTED}`,
            ),
          ),
        ).toBe(false);
      },
    );
  },
);

describe(
  "NativeFirstStrategy fallback",
  () => {
    it(
      "falls back to prompted when the provider genuinely rejects native tools, and reports why",
      async () => {
        const nativeClient =
          scriptedNativeClient([
            httpError(
              400,
              LITELLM_TOOLS_REJECTED,
            ),
          ]);

        const textClient =
          scriptedTextClient([
            JSON.stringify({
              action: "tool_call",
              tool: "create_docx",
              arguments: DOCX_ARGS,
            }),
          ]);

        const diagnostics: string[] = [];

        const {
          strategy,
          cache,
        } = nativeFirst(
          nativeClient,
          textClient,
        );

        const action =
          await strategy.getNextAction(
            CONTEXT,
            TOOLS,
            MODEL,
            (detail) =>
              diagnostics.push(detail),
          );

        expect(action).toMatchObject({
          kind: "tool_call",
          tool: "create_docx",
          arguments: DOCX_ARGS,
        });

        expect(nativeClient.calls).toBe(1);
        expect(textClient.calls).toHaveLength(1);

        expect(
          diagnostics.some(
            (detail) =>
              detail.startsWith(
                "Strategy fallback: native -> prompted",
              ) &&
              detail.includes(
                "provider rejected native tools (HTTP 400",
              ),
          ),
        ).toBe(true);

        expect(
          cache.get(
            ENDPOINT,
            MODEL,
          )?.reason,
        ).toContain(
          "provider rejected native tools",
        );
      },
    );

    it(
      "remembers the fallback for later turns in the same session, without repeating the native request",
      async () => {
        const nativeClient =
          scriptedNativeClient([
            httpError(
              400,
              LITELLM_TOOLS_REJECTED,
            ),
          ]);

        const textClient =
          scriptedTextClient([
            '{"action":"done"}',
            '{"action":"done"}',
            '{"action":"done"}',
          ]);

        const cache =
          new NativeSupportCache();

        const first =
          nativeFirst(
            nativeClient,
            textClient,
            cache,
          );

        await first.strategy.getNextAction(
          CONTEXT,
          TOOLS,
          MODEL,
        );

        // A later turn, on the same strategy instance.
        await first.strategy.getNextAction(
          {
            ...CONTEXT,
            goal: "Now create the PDF version of the same report.",
          },
          TOOLS,
          MODEL,
        );

        // A rebuilt strategy (as after a /model switch back) sharing the
        // session's cache.
        const diagnostics: string[] = [];

        await nativeFirst(
          nativeClient,
          textClient,
          cache,
        ).strategy.getNextAction(
          CONTEXT,
          TOOLS,
          MODEL,
          (detail) =>
            diagnostics.push(detail),
        );

        expect(nativeClient.calls).toBe(1);
        expect(textClient.calls).toHaveLength(3);
        expect(diagnostics[0]).toContain(
          "native tools were rejected earlier this session",
        );
      },
    );

    it(
      "keys the remembered fallback by endpoint and model, so other models and endpoints still try native",
      async () => {
        const cache =
          new NativeSupportCache();

        cache.markRejected(
          ENDPOINT,
          "model-a",
          "provider rejected native tools (HTTP 400: ...)",
        );

        const nativeClient =
          scriptedNativeClient([
            nativeText("Done."),
            nativeText("Done."),
          ]);

        const textClient =
          scriptedTextClient([]);

        const {
          strategy,
        } = nativeFirst(
          nativeClient,
          textClient,
          cache,
        );

        await strategy.getNextAction(
          CONTEXT,
          TOOLS,
          "model-b",
        );

        await nativeFirst(
          nativeClient,
          textClient,
          cache,
          "http://other-endpoint.test/v1",
        ).strategy.getNextAction(
          CONTEXT,
          TOOLS,
          "model-a",
        );

        expect(nativeClient.calls).toBe(2);
        expect(textClient.calls).toHaveLength(0);
      },
    );

    it(
      "does not downgrade on the parallel_tool_calls rejection that blocked the first acceptance test",
      async () => {
        const nativeClient =
          scriptedNativeClient([
            httpError(
              400,
              LITELLM_PARALLEL_REJECTED,
            ),
          ]);

        const textClient =
          scriptedTextClient([]);

        const {
          strategy,
          cache,
        } = nativeFirst(
          nativeClient,
          textClient,
        );

        await expect(
          strategy.getNextAction(
            CONTEXT,
            TOOLS,
            "gemma4-e4b-sky",
          ),
        ).rejects.toBeInstanceOf(
          NativeRequestHttpError,
        );

        expect(textClient.calls).toHaveLength(0);
        expect(
          cache.get(
            ENDPOINT,
            "gemma4-e4b-sky",
          ),
        ).toBeUndefined();
      },
    );

    it.each([
      [
        "401 authentication failure",
        httpError(
          401,
          '{"error":{"message":"Authentication Error, Invalid proxy server token passed."}}',
        ),
      ],
      [
        "403 forbidden",
        httpError(
          403,
          '{"error":{"message":"key not allowed to access model. This key can only access models=[...]"}}',
        ),
      ],
      [
        "429 rate limit",
        httpError(
          429,
          '{"error":{"message":"Rate limit exceeded"}}',
        ),
      ],
      [
        "500 server error, even if it mentions tools",
        httpError(
          500,
          LITELLM_TOOLS_REJECTED,
        ),
      ],
      [
        "502 bad gateway",
        httpError(
          502,
          "Bad Gateway",
        ),
      ],
      [
        "503 unavailable",
        httpError(
          503,
          "Service Unavailable",
        ),
      ],
      [
        "a network failure",
        new TypeError("fetch failed"),
      ],
      [
        "a timeout",
        Object.assign(
          new Error(
            "The operation was aborted due to timeout",
          ),
          {
            name: "TimeoutError",
          },
        ),
      ],
    ])(
      "does not downgrade on %s: the error propagates and native is tried again next time",
      async (_label, failure) => {
        const nativeClient =
          scriptedNativeClient([
            failure,
            nativeText("Recovered on native."),
          ]);

        const textClient =
          scriptedTextClient([]);

        const {
          strategy,
          cache,
        } = nativeFirst(
          nativeClient,
          textClient,
        );

        await expect(
          strategy.getNextAction(
            CONTEXT,
            TOOLS,
            MODEL,
          ),
        ).rejects.toBe(
          failure,
        );

        expect(
          cache.get(
            ENDPOINT,
            MODEL,
          ),
        ).toBeUndefined();

        const next =
          await strategy.getNextAction(
            CONTEXT,
            TOOLS,
            MODEL,
          );

        expect(next).toEqual({
          kind: "final_answer",
          text: "Recovered on native.",
          alreadyDisplayed: false,
        });

        expect(textClient.calls).toHaveLength(0);
      },
    );

    it(
      "does not downgrade on malformed native arguments: NativeStrategy corrects them itself",
      async () => {
        const nativeClient =
          scriptedNativeClient([
            {
              content: null,
              toolCalls: [
                {
                  id: "bad",
                  name: "create_docx",
                  argumentsJson: '{"path":"status.docx",',
                },
              ],
            },
            nativeCall(
              "good",
              "create_docx",
              DOCX_ARGS,
            ),
          ]);

        const textClient =
          scriptedTextClient([]);

        const {
          strategy,
          cache,
        } = nativeFirst(
          nativeClient,
          textClient,
        );

        const action =
          await strategy.getNextAction(
            CONTEXT,
            TOOLS,
            MODEL,
          );

        expect(action).toMatchObject({
          kind: "tool_call",
          callId: "good",
        });
        expect(textClient.calls).toHaveLength(0);
        expect(
          cache.get(
            ENDPOINT,
            MODEL,
          ),
        ).toBeUndefined();
      },
    );

    it(
      "does not downgrade on multiple native calls: none run, NativeStrategy corrects, still native",
      async () => {
        const nativeClient =
          scriptedNativeClient([
            {
              content: null,
              toolCalls: [
                {
                  id: "a",
                  name: "create_docx",
                  argumentsJson:
                    JSON.stringify(DOCX_ARGS),
                },
                {
                  id: "b",
                  name: "create_pdf",
                  argumentsJson:
                    JSON.stringify(PDF_ARGS),
                },
              ],
            },
            nativeCall(
              "c",
              "create_docx",
              DOCX_ARGS,
            ),
          ]);

        const textClient =
          scriptedTextClient([]);

        const {
          strategy,
          cache,
        } = nativeFirst(
          nativeClient,
          textClient,
        );

        const action =
          await strategy.getNextAction(
            CONTEXT,
            TOOLS,
            MODEL,
          );

        expect(action).toMatchObject({
          kind: "tool_call",
          callId: "c",
        });
        expect(textClient.calls).toHaveLength(0);
        expect(
          cache.get(
            ENDPOINT,
            MODEL,
          ),
        ).toBeUndefined();
      },
    );

    it(
      "does not downgrade on NativeStrategy's own corrective-retry exhaustion",
      async () => {
        const many: NativeCompletionResult = {
          content: null,
          toolCalls: [
            {
              id: "a",
              name: "create_docx",
              argumentsJson: "{",
            },
          ],
        };

        const nativeClient =
          scriptedNativeClient([
            many,
            many,
            many,
          ]);

        const textClient =
          scriptedTextClient([]);

        const {
          strategy,
          cache,
        } = nativeFirst(
          nativeClient,
          textClient,
        );

        await expect(
          strategy.getNextAction(
            CONTEXT,
            TOOLS,
            MODEL,
          ),
        ).rejects.toThrow(
          "could not obtain one compliant action",
        );

        expect(textClient.calls).toHaveLength(0);
        expect(
          cache.get(
            ENDPOINT,
            MODEL,
          ),
        ).toBeUndefined();
      },
    );

    it(
      "does not downgrade on an ordinary failed tool execution: the loop continues on native",
      async () => {
        const nativeClient =
          scriptedNativeClient([
            nativeCall(
              "c1",
              "create_docx",
              DOCX_ARGS,
            ),
            nativeCall(
              "c2",
              "create_docx",
              {
                ...DOCX_ARGS,
                path: "status-v2.docx",
              },
            ),
            nativeText(
              "status.docx already existed, so I created status-v2.docx.",
            ),
          ]);

        const textClient =
          scriptedTextClient([]);

        const executor =
          scriptedExecutor([
            {
              success: false,
              output: "status.docx already exists.",
            },
            {
              success: true,
              verified: true,
              output: "Created DOCX file at /work/status-v2.docx (8 KB).",
            },
          ]);

        const {
          strategy,
          cache,
        } = nativeFirst(
          nativeClient,
          textClient,
        );

        const outcome =
          await runAgentLoop(
            CONTEXT.goal,
            [],
            strategy,
            TOOLS,
            MODEL,
            executor,
            {
              async produce() {
                throw new Error(
                  "FinalAnswerProducer must not be used on the native path here",
                );
              },
            },
          );

        expect(outcome).toEqual({
          kind: "final_answer",
          text: "status.docx already existed, so I created status-v2.docx.",
          alreadyDisplayed: false,
        });
        expect(nativeClient.calls).toBe(3);
        expect(textClient.calls).toHaveLength(0);
        expect(
          cache.get(
            ENDPOINT,
            MODEL,
          ),
        ).toBeUndefined();
      },
    );

    it(
      "falls back safely mid-turn: prompted sees every real tool result already recorded",
      async () => {
        const nativeClient =
          scriptedNativeClient([
            nativeCall(
              "c1",
              "create_docx",
              DOCX_ARGS,
            ),
            httpError(
              400,
              '{"error":"registry.ollama.ai/library/tinymodel:latest does not support tools"}',
            ),
          ]);

        const textClient =
          scriptedTextClient([
            '{"action":"done"}',
          ]);

        const executor =
          scriptedExecutor([
            {
              success: true,
              verified: true,
              output: "Created DOCX file at /work/status.docx (8 KB).",
            },
          ]);

        const events: AgentEvent[] = [];

        const {
          strategy,
        } = nativeFirst(
          nativeClient,
          textClient,
        );

        const outcome =
          await runAgentLoop(
            CONTEXT.goal,
            [],
            strategy,
            TOOLS,
            MODEL,
            executor,
            {
              async produce() {
                return "Created status.docx.";
              },
            },
            (event) =>
              events.push(event),
          );

        expect(outcome).toEqual({
          kind: "final_answer",
          text: "Created status.docx.",
          alreadyDisplayed: true,
        });

        expect(textClient.calls[0]).toContain(
          "Created DOCX file at /work/status.docx (8 KB).",
        );

        expect(
          events.some(
            (event) =>
              event.type ===
                "protocol_condition" &&
              event.detail.startsWith(
                "Strategy fallback: native -> prompted",
              ),
          ),
        ).toBe(true);
      },
    );
  },
);

describe(
  "chat.ts NativeRequestHttpError",
  () => {
    const config: AppConfig = {
      apiUrl: ENDPOINT,
      apiKey: "temporary-test-key",
      defaultModel: "test-model",
      defaultPermissionMode: "default",
      compactionThreshold: 6_000,
      compactionStrategy: "summarise",
      compactionWindowSize: 20,
      mcpServers: [],
      pluginDirs: [],
    };

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it.each([
      [
        "non-streaming",
        requestNativeToolCompletion,
      ],
      [
        "streaming",
        streamNativeToolCompletion,
      ],
    ])(
      "the %s request throws it with the real status and body, keeping the original message",
      async (_label, send) => {
        vi.stubGlobal(
          "fetch",
          vi.fn(async () =>
            new Response(
              LITELLM_TOOLS_REJECTED,
              {
                status: 400,
              },
            ),
          ),
        );

        const failure =
          await send(
            config,
            MODEL,
            "system",
            [],
            [],
          ).catch(
            (error: unknown) => error,
          );

        expect(failure).toBeInstanceOf(
          NativeRequestHttpError,
        );
        expect(
          (failure as NativeRequestHttpError).status,
        ).toBe(400);
        expect(
          (failure as NativeRequestHttpError).body,
        ).toBe(
          LITELLM_TOOLS_REJECTED,
        );
        expect(
          (failure as Error).message,
        ).toBe(
          `LiteLLM native tool-calling request failed: HTTP 400: ${LITELLM_TOOLS_REJECTED}`,
        );
        expect(
          isNativeToolsUnsupportedError(
            failure,
          ),
        ).toBe(true);
      },
    );
  },
);
