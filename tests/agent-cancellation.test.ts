import {
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";

import {
  tmpdir,
} from "node:os";

import {
  join,
} from "node:path";

import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  isTurnCancellation,
  TurnCancelledError,
} from "../src/agent/cancellation.ts";

import {
  runAgentLoop,
} from "../src/agent/loop.ts";

import {
  NativeStrategy,
} from "../src/agent/strategies/native.ts";

import {
  createLiveToolExecutor,
} from "../src/agent/adapters/tool-executor.ts";

import {
  withNativeActivityIndicator,
} from "../src/agent/adapters/activity-indicator.ts";

import {
  requestNativeToolCompletion,
  streamChatCompletion,
  streamNativeToolCompletion,
} from "../src/chat.ts";

import {
  createSessionLogger,
} from "../src/session.ts";

import {
  BUILTIN_TOOL_DEFINITIONS,
} from "../src/agent/tool-schema.ts";

import type {
  AppConfig,
} from "../src/config.ts";

import type {
  NativeCompletionClient,
  NativeCompletionResult,
} from "../src/agent/model-client.ts";

import type {
  AgentAction,
  AgentEvent,
  AgentToolResult,
  ToolCallStrategy,
  ToolDefinition,
  ToolExecutor,
} from "../src/agent/types.ts";

/**
 * Tests for Ctrl+C turn cancellation: in-flight model requests abort, no new
 * tool starts, a running tool finishes, the turn ends "cancelled" without a
 * fabricated answer, cancellation is never recorded as a tool failure, and
 * nothing is ever logged after session_end.
 */

const TOOLS: ToolDefinition[] = [
  ...BUILTIN_TOOL_DEFINITIONS,
];

const DOCX_ARGS = {
  path: "status.docx",
  content: "# Status",
};

const NO_PRODUCER = {
  async produce(): Promise<string> {
    throw new Error(
      "FinalAnswerProducer must not be used",
    );
  },
};

/** A native client whose request hangs until the given signal aborts. */
function hangingNativeClient(): NativeCompletionClient & {
  calls: number;
} {
  const client = {
    calls: 0,
    complete(
      request: {
        signal?: AbortSignal;
      },
    ): Promise<NativeCompletionResult> {
      client.calls += 1;

      return new Promise(
        (_resolve, reject) => {
          request.signal?.addEventListener(
            "abort",
            () => {
              const abortError =
                new Error(
                  "This operation was aborted",
                );

              abortError.name =
                "AbortError";

              reject(abortError);
            },
          );
        },
      );
    },
  };

  return client;
}

function recordingExecutor(
  impl: (
    tool: string,
  ) => Promise<AgentToolResult>,
): ToolExecutor & {
  calls: string[];
} {
  const calls: string[] = [];

  return {
    calls,
    async execute(tool) {
      calls.push(tool);
      return impl(tool);
    },
  };
}

describe(
  "agent/cancellation.ts isTurnCancellation",
  () => {
    it.each([
      "TurnCancelledError",
      "AbortError",
      "ExitPromptError",
      "AbortPromptError",
    ])(
      "recognizes %s",
      (name) => {
        const error =
          new Error("x");

        error.name = name;

        expect(
          isTurnCancellation(error),
        ).toBe(true);
      },
    );

    it(
      "does not treat ordinary errors as cancellation unless the signal is aborted",
      () => {
        expect(
          isTurnCancellation(
            new Error("readline was closed"),
          ),
        ).toBe(false);

        expect(
          isTurnCancellation(
            new TypeError("fetch failed"),
          ),
        ).toBe(false);

        const controller =
          new AbortController();

        controller.abort();

        expect(
          isTurnCancellation(
            new Error("anything"),
            controller.signal,
          ),
        ).toBe(true);
      },
    );
  },
);

describe(
  "runAgentLoop cancellation",
  () => {
    it(
      "aborts an in-flight native request and ends cancelled, with no tool run and nothing recorded as a failure",
      async () => {
        const controller =
          new AbortController();

        const client =
          hangingNativeClient();

        const executor =
          recordingExecutor(
            async () => {
              throw new Error(
                "must not run",
              );
            },
          );

        const events: AgentEvent[] = [];

        const running =
          runAgentLoop(
            "Create a status DOCX report for the launch.",
            [],
            new NativeStrategy(
              client,
              "system prompt",
            ),
            TOOLS,
            "m",
            executor,
            NO_PRODUCER,
            (event) =>
              events.push(event),
            controller.signal,
          );

        await Promise.resolve();
        controller.abort();

        expect(
          await running,
        ).toEqual({
          kind: "cancelled",
        });

        expect(client.calls).toBe(1);
        expect(executor.calls).toHaveLength(0);

        expect(
          events.filter(
            (event) =>
              event.type ===
                "tool_result" ||
              event.type ===
                "tool_requested" ||
              event.type ===
                "final_answer",
          ),
        ).toEqual([]);

        expect(
          events.at(-1),
        ).toEqual({
          type: "protocol_condition",
          detail:
            "Turn cancelled by the user during a model request.",
        });
      },
    );

    it(
      "never acts on a model response that arrives after Ctrl+C",
      async () => {
        const controller =
          new AbortController();

        const strategy: ToolCallStrategy = {
          async getNextAction() {
            // Ctrl+C lands while the response is arriving.
            controller.abort();

            return {
              kind: "tool_call",
              tool: "create_docx",
              arguments: DOCX_ARGS,
              callId: "c1",
            } satisfies AgentAction;
          },
        };

        const executor =
          recordingExecutor(
            async () => ({
              success: true,
              output: "ran",
            }),
          );

        const events: AgentEvent[] = [];

        const outcome =
          await runAgentLoop(
            "goal",
            [],
            strategy,
            TOOLS,
            "m",
            executor,
            NO_PRODUCER,
            (event) =>
              events.push(event),
            controller.signal,
          );

        expect(outcome).toEqual({
          kind: "cancelled",
        });
        expect(executor.calls).toHaveLength(0);
        expect(
          events.some(
            (event) =>
              event.type ===
              "tool_requested",
          ),
        ).toBe(false);
      },
    );

    it(
      "lets a running tool finish, records its real result, and never calls the model again",
      async () => {
        const controller =
          new AbortController();

        let modelCalls = 0;

        const strategy: ToolCallStrategy = {
          async getNextAction() {
            modelCalls += 1;

            return {
              kind: "tool_call",
              tool: "create_docx",
              arguments: DOCX_ARGS,
              callId: `c${modelCalls}`,
            };
          },
        };

        const executor =
          recordingExecutor(
            async () => {
              // Ctrl+C while the tool is running.
              controller.abort();

              return {
                success: true,
                verified: true,
                output:
                  "Created DOCX file at /work/status.docx (8 KB).",
              };
            },
          );

        const events: AgentEvent[] = [];

        const outcome =
          await runAgentLoop(
            "goal",
            [],
            strategy,
            TOOLS,
            "m",
            executor,
            NO_PRODUCER,
            (event) =>
              events.push(event),
            controller.signal,
          );

        expect(outcome).toEqual({
          kind: "cancelled",
        });
        expect(modelCalls).toBe(1);
        expect(executor.calls).toHaveLength(1);

        expect(
          events.find(
            (event) =>
              event.type ===
              "tool_result",
          ),
        ).toMatchObject({
          success: true,
          output:
            "Created DOCX file at /work/status.docx (8 KB).",
        });

        expect(
          events.at(-1),
        ).toEqual({
          type: "protocol_condition",
          detail:
            'Turn cancelled by the user after "create_docx" finished running.',
        });
      },
    );

    it(
      "treats Ctrl+C inside an approval prompt as cancellation: the call is interrupted, never a tool failure",
      async () => {
        let modelCalls = 0;

        const strategy: ToolCallStrategy = {
          async getNextAction() {
            modelCalls += 1;

            return {
              kind: "tool_call",
              tool: "create_docx",
              arguments: DOCX_ARGS,
              callId: "c1",
            };
          },
        };

        const executor =
          recordingExecutor(
            async () => {
              const promptExit =
                new Error(
                  "User force closed the prompt with SIGINT",
                );

              promptExit.name =
                "ExitPromptError";

              throw promptExit;
            },
          );

        const events: AgentEvent[] = [];

        const outcome =
          await runAgentLoop(
            "goal",
            [],
            strategy,
            TOOLS,
            "m",
            executor,
            NO_PRODUCER,
            (event) =>
              events.push(event),
          );

        expect(outcome).toEqual({
          kind: "cancelled",
        });
        expect(modelCalls).toBe(1);

        expect(
          events.some(
            (event) =>
              event.type ===
              "tool_result",
          ),
        ).toBe(false);

        expect(
          events.filter(
            (event) =>
              event.type ===
              "tool_state_changed",
          ),
        ).toEqual([
          {
            type: "tool_state_changed",
            callId: "c1",
            state: "running",
          },
          {
            type: "tool_state_changed",
            callId: "c1",
            state: "interrupted",
          },
        ]);
      },
    );

    it(
      "still records a genuine tool failure as a failure (not cancellation) when the turn was not cancelled",
      async () => {
        const actions: AgentAction[] = [
          {
            kind: "tool_call",
            tool: "create_docx",
            arguments: DOCX_ARGS,
            callId: "c1",
          },
          {
            kind: "final_answer",
            text: "Creating status.docx failed: disk full.",
            alreadyDisplayed: true,
          },
        ];

        let step = 0;

        const events: AgentEvent[] = [];

        const outcome =
          await runAgentLoop(
            "goal",
            [],
            {
              async getNextAction() {
                const next =
                  actions[step]!;

                step += 1;

                return next;
              },
            },
            TOOLS,
            "m",
            recordingExecutor(
              async () => {
                throw new Error(
                  "disk full",
                );
              },
            ),
            NO_PRODUCER,
            (event) =>
              events.push(event),
            new AbortController().signal,
          );

        expect(outcome.kind).toBe(
          "final_answer",
        );

        expect(
          events.find(
            (event) =>
              event.type ===
              "tool_result",
          ),
        ).toMatchObject({
          success: false,
          output: "disk full",
        });
      },
    );

    it(
      "stops NativeStrategy's corrective retries once cancelled",
      async () => {
        const controller =
          new AbortController();

        let calls = 0;

        const client: NativeCompletionClient = {
          async complete() {
            calls += 1;
            controller.abort();

            return {
              content: null,
              toolCalls: [
                {
                  id: "bad",
                  name: "create_docx",
                  argumentsJson: "{",
                },
              ],
            };
          },
        };

        const outcome =
          await runAgentLoop(
            "Create a status DOCX report for the launch.",
            [],
            new NativeStrategy(
              client,
              "system prompt",
            ),
            TOOLS,
            "m",
            recordingExecutor(
              async () => ({
                success: true,
                output: "x",
              }),
            ),
            NO_PRODUCER,
            undefined,
            controller.signal,
          );

        expect(outcome).toEqual({
          kind: "cancelled",
        });
        expect(calls).toBe(1);
      },
    );

    it(
      "stops the Thinking spinner when the request is aborted",
      async () => {
        const controller =
          new AbortController();

        const log: string[] = [];

        const wrapped =
          withNativeActivityIndicator(
            hangingNativeClient(),
            () => {
              log.push("start");

              return () => {
                log.push("stop");
              };
            },
          );

        const pending =
          wrapped.complete({
            model: "m",
            systemPrompt: "s",
            turns: [],
            tools: [],
            parallelToolCalls: false,
            signal: controller.signal,
          });

        controller.abort();

        await expect(pending).rejects.toMatchObject({
          name: "AbortError",
        });
        expect(log).toEqual([
          "start",
          "stop",
        ]);
      },
    );
  },
);

describe(
  "the live executor never starts a tool after cancellation",
  () => {
    it(
      "throws TurnCancelledError before validation, approval, or pausing readline",
      async () => {
        const controller =
          new AbortController();

        controller.abort();

        const readline = {
          pause: vi.fn(),
          resume: vi.fn(),
        };

        const executor =
          createLiveToolExecutor(
            {} as never,
            {} as never,
            readline,
            undefined,
          );

        await expect(
          executor.execute(
            "create_docx",
            DOCX_ARGS,
            controller.signal,
          ),
        ).rejects.toBeInstanceOf(
          TurnCancelledError,
        );

        expect(readline.pause).not.toHaveBeenCalled();
      },
    );
  },
);

describe(
  "chat.ts passes the cancellation signal to fetch",
  () => {
    const config: AppConfig = {
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

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it.each([
      [
        "streamChatCompletion",
        (signal: AbortSignal) =>
          streamChatCompletion(
            config,
            "m",
            [],
            () => {},
            "s",
            undefined,
            signal,
          ),
      ],
      [
        "requestNativeToolCompletion",
        (signal: AbortSignal) =>
          requestNativeToolCompletion(
            config,
            "m",
            "s",
            [],
            [],
            signal,
          ),
      ],
      [
        "streamNativeToolCompletion",
        (signal: AbortSignal) =>
          streamNativeToolCompletion(
            config,
            "m",
            "s",
            [],
            [],
            undefined,
            signal,
          ),
      ],
    ])(
      "%s",
      async (_label, send) => {
        const fetchMock = vi.fn(
          async () =>
            new Response(
              "unavailable",
              {
                status: 503,
              },
            ),
        );

        vi.stubGlobal(
          "fetch",
          fetchMock,
        );

        const controller =
          new AbortController();

        await send(
          controller.signal,
        ).catch(() => {});

        const init =
          (
            fetchMock.mock.calls[0] as unknown as [
              string,
              RequestInit,
            ]
          )[1];

        expect(init.signal).toBe(
          controller.signal,
        );
      },
    );
  },
);

describe(
  "nothing is ever logged after session_end",
  () => {
    let directory = "";

    afterEach(async () => {
      if (directory !== "") {
        await rm(
          directory,
          {
            recursive: true,
            force: true,
          },
        );
      }
    });

    it(
      "the session logger drops every record appended after session_end",
      async () => {
        directory =
          await mkdtemp(
            join(
              tmpdir(),
              "sky-cancel-",
            ),
          );

        const logger =
          await createSessionLogger(
            directory,
          );

        await logger.append({
          type: "session_start",
          workingDirectory: "/work",
          model: "m",
        });

        await logger.append({
          type: "session_end",
          model: "m",
        });

        // The late events from the live log: a tool request, its result, and
        // more model activity after the session had ended.
        await logger.append({
          type: "agent_event",
          agentEvent: {
            type: "tool_requested",
            callId: "late",
            tool: "create_docx",
            arguments: DOCX_ARGS,
          },
          model: "m",
        });

        await logger.append({
          type: "agent_event",
          agentEvent: {
            type: "tool_result",
            callId: "late",
            success: false,
            verified: false,
            output: "readline was closed",
          },
          model: "m",
        });

        const lines =
          (
            await readFile(
              logger.filePath,
              "utf8",
            )
          )
            .trim()
            .split("\n")
            .map(
              (line) =>
                JSON.parse(line).type as string,
            );

        expect(lines).toEqual([
          "session_start",
          "session_end",
        ]);
      },
    );

    it(
      "shutdown stops and waits for the active turn before writing session_end, and Ctrl+C mid-turn cancels instead of shutting down",
      async () => {
        const source =
          await readFile(
            join(
              process.cwd(),
              "src",
              "index.ts",
            ),
            "utf8",
          );

        const shutdownBody =
          source.slice(
            source.indexOf(
              "function requestShutdown():",
            ),
            source.indexOf(
              "function handleInterrupt():",
            ),
          );

        const awaitTurn =
          shutdownBody.indexOf(
            "await activeTurn.settled;",
          );

        const sessionEnd =
          shutdownBody.indexOf(
            "await saveSessionEnd();",
          );

        expect(awaitTurn).toBeGreaterThan(-1);
        expect(sessionEnd).toBeGreaterThan(
          awaitTurn,
        );

        expect(source).toContain(
          [
            "  readline.on(",
            "    \"SIGINT\",",
            "    handleInterrupt,",
            "  );",
          ].join("\n"),
        );

        expect(source).toContain(
          "          turnController.signal,",
        );
      },
    );
  },
);
