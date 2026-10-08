import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";

import {
  tmpdir,
} from "node:os";

import {
  join,
} from "node:path";

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import {
  createPhase1ToolHandlers,
} from "../src/toolhandlers.ts";

import {
  suggestAlternativeOutputPath,
} from "../src/docgen/shared.ts";

import {
  createLiveToolExecutor,
} from "../src/agent/adapters/tool-executor.ts";

import {
  describeRecovery,
  findUnresolvedSafeRecovery,
} from "../src/agent/recovery.ts";

import {
  describeToolResultForNative,
  renderHistoryAsPlainTurns,
} from "../src/agent/history-rendering.ts";

import {
  RepeatGuard,
  describeBlockedRepeat,
} from "../src/agent/repeat-guard.ts";

import {
  runAgentLoop,
} from "../src/agent/loop.ts";

import {
  NativeStrategy,
} from "../src/agent/strategies/native.ts";

import {
  BUILTIN_TOOL_DEFINITIONS,
} from "../src/agent/tool-schema.ts";

import {
  HookRegistry,
} from "../src/hooks.ts";

import type {
  NativeCompletionClient,
  NativeCompletionRequest,
  NativeCompletionResult,
  NativeConversationTurn,
} from "../src/agent/model-client.ts";

import type {
  AgentEvent,
  AgentToolResult,
  ToolDefinition,
  ToolExecutor,
} from "../src/agent/types.ts";

/**
 * Tests for recoverable tool failures: the document tools' safe
 * OUTPUT_PATH_EXISTS recovery, its passage through executor, native and
 * plain history, the repeated-action breaker, and NativeStrategy's
 * once-per-turn reminder, plus the gemma4-e2b-sky live sequence it targets.
 */

const TOOLS: ToolDefinition[] = [
  ...BUILTIN_TOOL_DEFINITIONS,
];

const SUMMARY = "Northbridge_Office_Electrical_Upgrade_Summary";

const DOCX_ARGS = {
  path: `${SUMMARY}.docx`,
  content: "# Northbridge Office Electrical Upgrade\n\nClient: Daniel Mercer",
};

describe(
  "document tools: OUTPUT_PATH_EXISTS is a safe, recoverable failure",
  () => {
    let directory = "";

    beforeEach(async () => {
      directory =
        await mkdtemp(
          join(
            tmpdir(),
            "sky-recover-",
          ),
        );
    });

    afterEach(async () => {
      await rm(
        directory,
        {
          recursive: true,
          force: true,
        },
      );
    });

    function handlers() {
      return createPhase1ToolHandlers(
        directory,
        {
          getMode: () => "bypass",
          approvalPrompt: async () => true,
        },
      );
    }

    it(
      "marks an existing DOCX path recoverable and suggests a concrete unused name, leaving the original untouched",
      async () => {
        const original =
          join(
            directory,
            `${SUMMARY}.docx`,
          );

        await writeFile(
          original,
          "ORIGINAL CONTENT",
        );

        const before =
          await stat(original);

        const result =
          await handlers().create_docx(
            DOCX_ARGS,
          );

        expect(result).toMatchObject({
          success: false,
          errorCode: "OUTPUT_PATH_EXISTS",
          recoverable: true,
          suggestedArguments: {
            path: `${SUMMARY}_2.docx`,
          },
        });

        expect(result.recoveryHint).toBe(
          "Retry the same creation tool using the suggested unused path. Do not delete or overwrite the existing file. Continue the remaining requested work without asking the user.",
        );

        expect(result.output).toContain(
          "already exists and was not modified",
        );

        // The original is neither overwritten nor deleted, and the
        // suggestion is never executed on the model's behalf.
        expect(
          await readFile(
            original,
            "utf8",
          ),
        ).toBe(
          "ORIGINAL CONTENT",
        );
        expect(
          (await stat(original)).mtimeMs,
        ).toBe(
          before.mtimeMs,
        );
        expect(
          (
            await readdir(directory)
          ).sort(),
        ).toEqual([
          `${SUMMARY}.docx`,
        ]);
      },
    );

    it.each([
      [
        "create_pdf",
        "report.pdf",
        {
          content: "# R",
        },
      ],
      [
        "create_xlsx",
        "budget.xlsx",
        {
          sheets: [
            {
              name: "S",
              rows: [
                [
                  1,
                ],
              ],
            },
          ],
        },
      ],
      [
        "create_pptx",
        "deck.pptx",
        {
          slides: [
            {
              type: "title",
              title: "T",
            },
          ],
        },
      ],
    ])(
      "%s reports the same recoverable failure",
      async (tool, name, extra) => {
        await writeFile(
          join(
            directory,
            name,
          ),
          "x",
        );

        const toolHandlers =
          handlers() as unknown as Record<
            string,
            (args: unknown) => Promise<{
              recoverable?: boolean;
              suggestedArguments?: Record<string, unknown>;
            }>
          >;

        const result =
          await toolHandlers[tool]!({
            path: name,
            ...extra,
          });

        expect(result.recoverable).toBe(true);
        expect(
          result.suggestedArguments?.path,
        ).toBe(
          name.replace(
            ".",
            "_2.",
          ),
        );
      },
    );

    it(
      "suggests _3 when _2 also exists, and continues from an already-numbered name",
      async () => {
        await writeFile(
          join(
            directory,
            "foo.docx",
          ),
          "1",
        );
        await writeFile(
          join(
            directory,
            "foo_2.docx",
          ),
          "2",
        );

        expect(
          suggestAlternativeOutputPath(
            "foo.docx",
            directory,
          ),
        ).toBe(
          "foo_3.docx",
        );

        expect(
          suggestAlternativeOutputPath(
            "foo_2.docx",
            directory,
          ),
        ).toBe(
          "foo_3.docx",
        );
      },
    );

    it(
      "keeps the caller's directory and relative form, and handles names without an extension",
      async () => {
        await mkdir(
          join(
            directory,
            "out",
          ),
        );
        await writeFile(
          join(
            directory,
            "out",
            "a.pdf",
          ),
          "x",
        );

        expect(
          suggestAlternativeOutputPath(
            "out/a.pdf",
            directory,
          ),
        ).toBe(
          "out/a_2.pdf",
        );

        expect(
          suggestAlternativeOutputPath(
            "README",
            directory,
          ),
        ).toBe(
          "README_2",
        );
      },
    );

    it(
      "does not mark other failures recoverable",
      async () => {
        // A build failure inside the document tool (a missing image): a real
        // failure, but not one with a known safe retry.
        const result =
          await handlers().create_pptx({
            path: "deck.pptx",
            slides: [
              {
                type: "content",
                title: "T",
                image: {
                  path: "missing-image.png",
                },
              },
            ],
          });

        expect(result.success).toBe(false);
        expect(
          (result as { recoverable?: boolean }).recoverable,
        ).toBeUndefined();
      },
    );

    it(
      "the live executor passes the recovery metadata through unchanged",
      async () => {
        await writeFile(
          join(
            directory,
            `${SUMMARY}.docx`,
          ),
          "ORIGINAL",
        );

        const executor =
          createLiveToolExecutor(
            handlers(),
            new HookRegistry(),
            {
              pause() {},
              resume() {},
            },
            undefined,
          );

        expect(
          await executor.execute(
            "create_docx",
            DOCX_ARGS,
          ),
        ).toMatchObject({
          success: false,
          errorCode: "OUTPUT_PATH_EXISTS",
          recoverable: true,
          suggestedArguments: {
            path: `${SUMMARY}_2.docx`,
          },
        });
      },
    );
  },
);

const RECOVERABLE_FAILURE: AgentToolResult = {
  success: false,
  output:
    "The requested output path already exists and was not modified: /work/Northbridge_Office_Electrical_Upgrade_Summary.docx. Sky Code's document tools never overwrite an existing file.",
  errorCode: "OUTPUT_PATH_EXISTS",
  recoverable: true,
  recoveryHint:
    "Retry the same creation tool using the suggested unused path. Do not delete or overwrite the existing file. Continue the remaining requested work without asking the user.",
  suggestedArguments: {
    path: `${SUMMARY}_2.docx`,
  },
};

describe(
  "recovery metadata in history",
  () => {
    const event: Extract<
      AgentEvent,
      { type: "tool_result" }
    > = {
      type: "tool_result",
      callId: "c1",
      success: false,
      verified: false,
      output: RECOVERABLE_FAILURE.output,
      errorCode: "OUTPUT_PATH_EXISTS",
      recoverable: true,
      recoveryHint: RECOVERABLE_FAILURE.recoveryHint!,
      suggestedArguments: RECOVERABLE_FAILURE.suggestedArguments!,
    };

    it(
      "survives native role:tool rendering as structured fields plus a concrete retry",
      () => {
        const parsed =
          JSON.parse(
            describeToolResultForNative(
              event,
              "create_docx",
            ),
          );

        expect(parsed).toEqual({
          status: "failed",
          output: RECOVERABLE_FAILURE.output,
          error_code: "OUTPUT_PATH_EXISTS",
          recoverable: true,
          recovery:
            "This failure is recoverable. Retry the same creation tool using the suggested unused path. Do not delete or overwrite the existing file. Continue the remaining requested work without asking the user. " +
            `Suggested retry: create_docx with the same arguments, changing: path = "${SUMMARY}_2.docx".`,
          suggested_arguments: {
            path: `${SUMMARY}_2.docx`,
          },
        });

        // The real failure is preserved, and nothing claims the retry ran.
        expect(parsed.status).toBe("failed");
      },
    );

    it(
      "survives plain-text rendering for Prompted and Legacy",
      () => {
        const turns =
          renderHistoryAsPlainTurns([
            {
              type: "tool_requested",
              callId: "c1",
              tool: "create_docx",
              arguments: DOCX_ARGS,
            },
            event,
          ]);

        expect(turns[1]!.content).toContain(
          "Result: failed",
        );
        expect(turns[1]!.content).toContain(
          `Suggested retry: create_docx with the same arguments, changing: path = "${SUMMARY}_2.docx".`,
        );
      },
    );

    it(
      "adds nothing for a failure without recovery metadata",
      () => {
        expect(
          JSON.parse(
            describeToolResultForNative(
              {
                type: "tool_result",
                callId: "c2",
                success: false,
                verified: false,
                output: "disk full",
              },
              "create_docx",
            ),
          ),
        ).toEqual({
          status: "failed",
          output: "disk full",
        });
      },
    );
  },
);

describe(
  "repeat guard keeps the recovery",
  () => {
    it(
      "repeats the original failure's suggested arguments when it blocks the identical call",
      () => {
        const guard =
          new RepeatGuard();

        for (
          let i = 0;
          i < 2;
          i += 1
        ) {
          guard.recordResult(
            "create_docx",
            DOCX_ARGS,
            false,
            RECOVERABLE_FAILURE.output,
            {
              errorCode: "OUTPUT_PATH_EXISTS",
              recoveryHint: RECOVERABLE_FAILURE.recoveryHint!,
              suggestedArguments: RECOVERABLE_FAILURE.suggestedArguments!,
            },
          );
        }

        const check =
          guard.check(
            "create_docx",
            DOCX_ARGS,
          );

        expect(check).toMatchObject({
          blocked: true,
          priorBlocks: 0,
          recovery: {
            suggestedArguments: {
              path: `${SUMMARY}_2.docx`,
            },
          },
        });

        if (!check.blocked) {
          throw new Error("expected a block");
        }

        const text =
          describeBlockedRepeat(
            "create_docx",
            check,
          );

        expect(text).toContain(
          "The previous failure is recoverable.",
        );
        expect(text).toContain(
          `changing: path = "${SUMMARY}_2.docx"`,
        );
        expect(text).toContain(
          "Do not repeat the same call.",
        );
      },
    );
  },
);

/** A native client driven by a fixed script, recording deep copies of requests. */
function scriptedNativeClient(
  results: NativeCompletionResult[],
): NativeCompletionClient & {
  requests: NativeCompletionRequest[];
} {
  const requests: NativeCompletionRequest[] = [];

  return {
    requests,
    async complete(request) {
      requests.push(
        structuredClone(request),
      );

      const next =
        results[requests.length - 1];

      if (!next) {
        throw new Error(
          "scriptedNativeClient ran out of scripted results",
        );
      }

      return next;
    },
  };
}

function call(
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

function text(
  content: string,
): NativeCompletionResult {
  return {
    content,
    toolCalls: [],
  };
}

function scriptedExecutor(
  results: AgentToolResult[],
): ToolExecutor & {
  calls: {
    tool: string;
    args: unknown;
  }[];
} {
  const calls: {
    tool: string;
    args: unknown;
  }[] = [];

  return {
    calls,
    async execute(tool, args) {
      calls.push({
        tool,
        args,
      });

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

const NO_PRODUCER = {
  async produce(): Promise<string> {
    throw new Error(
      "FinalAnswerProducer must not be used",
    );
  },
};

const RETRY_ARGS = {
  ...DOCX_ARGS,
  path: `${SUMMARY}_2.docx`,
};

describe(
  "weak-model recovery in the native loop",
  () => {
    it(
      "repeats the identical call, gets the guard's recovery, then uses the suggested path",
      async () => {
        const client =
          scriptedNativeClient([
            call(
              "c1",
              "create_docx",
              DOCX_ARGS,
            ),
            call(
              "c2",
              "create_docx",
              DOCX_ARGS,
            ),
            call(
              "c3",
              "create_docx",
              DOCX_ARGS,
            ),
            call(
              "c4",
              "create_docx",
              RETRY_ARGS,
            ),
            text(
              `${SUMMARY}.docx already existed and was left unchanged, so I created ${SUMMARY}_2.docx instead.`,
            ),
          ]);

        const executor =
          scriptedExecutor([
            RECOVERABLE_FAILURE,
            RECOVERABLE_FAILURE,
            {
              success: true,
              verified: true,
              output: `Created DOCX file at /work/${SUMMARY}_2.docx (8 KB).`,
            },
          ]);

        const outcome =
          await runAgentLoop(
            "Create a professional DOCX project summary for Northbridge.",
            [],
            new NativeStrategy(
              client,
              "system prompt",
            ),
            TOOLS,
            "gemma4-e2b-sky",
            executor,
            NO_PRODUCER,
          );

        expect(
          executor.calls.map(
            (c) =>
              (c.args as { path: string }).path,
          ),
        ).toEqual([
          `${SUMMARY}.docx`,
          `${SUMMARY}.docx`,
          `${SUMMARY}_2.docx`,
        ]);

        expect(outcome.kind).toBe(
          "final_answer",
        );

        // The blocked c3 reply, as the model saw it, carries the recovery.
        const blocked =
          client.requests[3]!.turns.find(
            (
              turn,
            ): turn is Extract<
              NativeConversationTurn,
              { role: "tool" }
            > =>
              turn.role === "tool" &&
              turn.toolCallId === "c3",
          )!;

        const parsed =
          JSON.parse(
            blocked.content,
          );

        expect(parsed).toMatchObject({
          status: "not_executed",
          error_code: "OUTPUT_PATH_EXISTS",
          recoverable: true,
          suggested_arguments: {
            path: `${SUMMARY}_2.docx`,
          },
        });
        expect(parsed.output).toContain(
          "The previous failure is recoverable.",
        );
      },
    );

    it(
      "ends the turn honestly when the identical blocked call is requested again, naming the unused safe retry",
      async () => {
        const client =
          scriptedNativeClient([
            call(
              "c1",
              "create_docx",
              DOCX_ARGS,
            ),
            call(
              "c2",
              "create_docx",
              DOCX_ARGS,
            ),
            call(
              "c3",
              "create_docx",
              DOCX_ARGS,
            ),
            call(
              "c4",
              "create_docx",
              DOCX_ARGS,
            ),
          ]);

        const executor =
          scriptedExecutor([
            RECOVERABLE_FAILURE,
            RECOVERABLE_FAILURE,
          ]);

        const events: AgentEvent[] = [];

        const outcome =
          await runAgentLoop(
            "Create a professional DOCX project summary for Northbridge.",
            [],
            new NativeStrategy(
              client,
              "system prompt",
            ),
            TOOLS,
            "gemma4-e2b-sky",
            executor,
            NO_PRODUCER,
            (event) =>
              events.push(event),
          );

        // Only two real executions; c3 and c4 were never run.
        expect(executor.calls).toHaveLength(2);

        // No further model request after the second block.
        expect(client.requests).toHaveLength(4);

        expect(outcome.kind).toBe(
          "final_answer",
        );

        const answer =
          (outcome as { text: string }).text;

        expect(answer).toContain(
          "I stopped because the same create_docx call kept being requested",
        );
        expect(answer).toContain(
          `A safe retry was available but was not used: create_docx with the same arguments, changing path = "${SUMMARY}_2.docx".`,
        );

        // c4 still has its canonical not-executed result before the end.
        expect(
          events.find(
            (event) =>
              event.type === "tool_result" &&
              event.callId === "c4",
          ),
        ).toMatchObject({
          notExecuted: true,
          recoverable: true,
        });
      },
    );
  },
);

describe(
  "NativeStrategy reminds the model once about an unused safe recovery",
  () => {
    it(
      "gives one correction when the model asks the user instead of using the safe retry, and it continues",
      async () => {
        const client =
          scriptedNativeClient([
            call(
              "c1",
              "create_docx",
              DOCX_ARGS,
            ),
            text(
              "The file already exists. What would you like me to do?",
            ),
            call(
              "c2",
              "create_docx",
              RETRY_ARGS,
            ),
            text(
              `Created ${SUMMARY}_2.docx because ${SUMMARY}.docx already existed.`,
            ),
          ]);

        const executor =
          scriptedExecutor([
            RECOVERABLE_FAILURE,
            {
              success: true,
              verified: true,
              output: "Created",
            },
          ]);

        const outcome =
          await runAgentLoop(
            "Create a professional DOCX project summary for Northbridge.",
            [],
            new NativeStrategy(
              client,
              "system prompt",
            ),
            TOOLS,
            "gemma4-e2b-sky",
            executor,
            NO_PRODUCER,
          );

        expect(executor.calls).toHaveLength(2);
        expect(outcome).toMatchObject({
          kind: "final_answer",
          text: `Created ${SUMMARY}_2.docx because ${SUMMARY}.docx already existed.`,
        });

        const reminder =
          client.requests[2]!.turns.at(-1)!;

        expect(
          (reminder as { content: string }).content,
        ).toContain(
          "A safe recovery is already available in the recorded tool result.",
        );
      },
    );

    it(
      "reminds at most once per turn; a second refusal is accepted as the honest answer",
      async () => {
        const refusal =
          text(
            "I left the existing file unchanged and did not create a new one; tell me if you want a different name.",
          );

        const client =
          scriptedNativeClient([
            call(
              "c1",
              "create_docx",
              DOCX_ARGS,
            ),
            refusal,
            refusal,
          ]);

        const outcome =
          await runAgentLoop(
            "Create a professional DOCX project summary for Northbridge.",
            [],
            new NativeStrategy(
              client,
              "system prompt",
            ),
            TOOLS,
            "gemma4-e2b-sky",
            scriptedExecutor([
              RECOVERABLE_FAILURE,
            ]),
            NO_PRODUCER,
          );

        expect(client.requests).toHaveLength(3);
        expect(outcome).toMatchObject({
          kind: "final_answer",
          text: refusal.content,
        });
      },
    );

    it(
      "never pushes a retry for a failure that is not explicitly marked safely recoverable",
      async () => {
        const client =
          scriptedNativeClient([
            call(
              "c1",
              "create_docx",
              DOCX_ARGS,
            ),
            text(
              "Creating the DOCX failed: permission denied. Please check the folder permissions.",
            ),
          ]);

        const outcome =
          await runAgentLoop(
            "Create a professional DOCX project summary for Northbridge.",
            [],
            new NativeStrategy(
              client,
              "system prompt",
            ),
            TOOLS,
            "m",
            scriptedExecutor([
              {
                success: false,
                output: "Permission denied.",
              },
            ]),
            NO_PRODUCER,
          );

        expect(client.requests).toHaveLength(2);
        expect(outcome.kind).toBe(
          "final_answer",
        );
      },
    );
  },
);

describe(
  "findUnresolvedSafeRecovery",
  () => {
    const failed: AgentEvent[] = [
      {
        type: "tool_requested",
        callId: "c1",
        tool: "create_docx",
        arguments: DOCX_ARGS,
      },
      {
        type: "tool_result",
        callId: "c1",
        success: false,
        verified: false,
        output: "exists",
        recoverable: true,
        suggestedArguments: {
          path: `${SUMMARY}_2.docx`,
        },
      },
    ];

    it(
      "is unresolved until the same call succeeds with only the suggested fields changed",
      () => {
        expect(
          findUnresolvedSafeRecovery(
            failed,
          )?.tool,
        ).toBe(
          "create_docx",
        );
      },
    );

    it(
      "counts the model's own different filename as resolving it",
      () => {
        expect(
          findUnresolvedSafeRecovery([
            ...failed,
            {
              type: "tool_requested",
              callId: "c2",
              tool: "create_docx",
              arguments: {
                ...DOCX_ARGS,
                path: "summary-v2.docx",
              },
            },
            {
              type: "tool_result",
              callId: "c2",
              success: true,
              verified: true,
              output: "Created",
            },
          ]),
        ).toBeUndefined();
      },
    );

    it(
      "does not count an unrelated success of the same tool (different content) as resolving it",
      () => {
        expect(
          findUnresolvedSafeRecovery([
            ...failed,
            {
              type: "tool_requested",
              callId: "c2",
              tool: "create_docx",
              arguments: {
                path: "other.docx",
                content: "A different document",
              },
            },
            {
              type: "tool_result",
              callId: "c2",
              success: true,
              verified: true,
              output: "Created",
            },
          ])?.tool,
        ).toBe(
          "create_docx",
        );
      },
    );

    it(
      "ignores failures without explicit recoverable metadata",
      () => {
        expect(
          findUnresolvedSafeRecovery([
            {
              type: "tool_requested",
              callId: "c1",
              tool: "run_shell_command",
              arguments: {
                command: "rm x",
              },
            },
            {
              type: "tool_result",
              callId: "c1",
              success: false,
              verified: false,
              output: "x is in use",
            },
          ]),
        ).toBeUndefined();
      },
    );

    it(
      "describes the retry without inventing anything",
      () => {
        expect(
          describeRecovery(
            "create_pdf",
            {
              suggestedArguments: {
                path: "r_2.pdf",
              },
            },
          ),
        ).toBe(
          'This failure is recoverable. Suggested retry: create_pdf with the same arguments, changing: path = "r_2.pdf". Continue the remaining requested work without asking the user, unless the user explicitly required the original value.',
        );
      },
    );
  },
);
