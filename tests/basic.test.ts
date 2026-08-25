import {
  mkdtemp,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type {
  ChatMessage,
} from "../src/chat.ts";

import {
  compactConversation,
} from "../src/compact.ts";

import {
  editFileOnDisk,
  readFileFromDisk,
  writeFileToDisk,
} from "../src/fileops.ts";

import {
  executeSkyToolRequestWithHooks,
  HookRegistry,
} from "../src/hooks.ts";

import {
  PermissionController,
} from "../src/permissions.ts";

import {
  createSkyCodeSystemPrompt,
  executeSkyToolRequest,
  getExampleSkyToolInvocation,
  parseSkyToolRequest,
  SkyToolValidationError,
  TOOL_NAMES,
} from "../src/tools.ts";

describe(
  "Sky Code tool-request parser",
  () => {
    it(
      "returns null for a normal assistant response",
      () => {
        expect(
          parseSkyToolRequest(
            "This is a normal assistant response.",
          ),
        ).toBeNull();
      },
    );

    it(
      "parses a valid read_file request",
      () => {
        const response = [
          "```sky-tool",
          '{"tool":"read_file","args":{"path":"/tmp/example.txt"}}',
          "```",
        ].join("\n");

        expect(
          parseSkyToolRequest(
            response,
          ),
        ).toEqual({
          tool: "read_file",
          args: {
            path:
              "/tmp/example.txt",
          },
        });
      },
    );

    it(
      "parses a valid MCP tool request",
      () => {
        const response = [
          "```sky-tool",
          '{"tool":"mcp_call","args":{"server":"test-server","name":"phase2_ping","arguments":{"value":"hello"}}}',
          "```",
        ].join("\n");

        expect(
          parseSkyToolRequest(
            response,
          ),
        ).toEqual({
          tool: "mcp_call",
          args: {
            server:
              "test-server",
            name:
              "phase2_ping",
            arguments: {
              value:
                "hello",
            },
          },
        });
      },
    );

    it(
      "uses an empty argument object when MCP arguments are omitted",
      () => {
        const response = [
          "```sky-tool",
          '{"tool":"mcp_call","args":{"server":"test-server","name":"phase2_ping"}}',
          "```",
        ].join("\n");

        expect(
          parseSkyToolRequest(
            response,
          ),
        ).toEqual({
          tool: "mcp_call",
          args: {
            server:
              "test-server",
            name:
              "phase2_ping",
            arguments: {},
          },
        });
      },
    );

    it(
      "accepts trailing commentary after a valid tool block",
      () => {
        const response = [
          "```sky-tool",
          '{"tool":"run_shell_command","args":{"command":"whoami"}}',
          "```",
          "This premature commentary should be ignored.",
        ].join("\n");

        expect(
          parseSkyToolRequest(
            response,
          ),
        ).toEqual({
          tool:
            "run_shell_command",
          args: {
            command:
              "whoami",
          },
        });
      },
    );

    it(
      "rejects text before a tool block",
      () => {
        const response = [
          "I will use a tool.",
          "```sky-tool",
          '{"tool":"read_file","args":{"path":"/tmp/example.txt"}}',
          "```",
        ].join("\n");

        expect(() =>
          parseSkyToolRequest(
            response,
          ),
        ).toThrow(
          "A sky-tool request must begin the model response",
        );
      },
    );

    it(
      "throws a plain Error, not SkyToolValidationError, when the tool name itself cannot be determined",
      () => {
        const response = [
          "```sky-tool",
          '{"tool":"not_a_real_tool","args":{}}',
          "```",
        ].join("\n");

        expect(() =>
          parseSkyToolRequest(
            response,
          ),
        ).toThrow(
          "Unknown Sky Code tool: not_a_real_tool",
        );

        try {
          parseSkyToolRequest(
            response,
          );
        } catch (error) {
          expect(
            error,
          ).not.toBeInstanceOf(
            SkyToolValidationError,
          );
        }
      },
    );

    it(
      "throws SkyToolValidationError carrying the known tool name when args is not an object",
      () => {
        const response = [
          "```sky-tool",
          '{"tool":"run_shell_command","args":"ls -la"}',
          "```",
        ].join("\n");

        try {
          parseSkyToolRequest(
            response,
          );

          expect.fail(
            "expected parseSkyToolRequest to throw",
          );
        } catch (error) {
          expect(
            error,
          ).toBeInstanceOf(
            SkyToolValidationError,
          );

          expect(
            (
              error as SkyToolValidationError
            ).toolName,
          ).toBe(
            "run_shell_command",
          );
        }
      },
    );

    it(
      "throws SkyToolValidationError carrying the known tool name for a tool-specific argument failure",
      () => {
        const response = [
          "```sky-tool",
          '{"tool":"delegate_to_agent","args":{"agent":"reviewer","task":"review this","context":123}}',
          "```",
        ].join("\n");

        try {
          parseSkyToolRequest(
            response,
          );

          expect.fail(
            "expected parseSkyToolRequest to throw",
          );
        } catch (error) {
          expect(
            error,
          ).toBeInstanceOf(
            SkyToolValidationError,
          );

          expect(
            (
              error as SkyToolValidationError
            ).toolName,
          ).toBe(
            "delegate_to_agent",
          );
        }
      },
    );

    it.each(
      TOOL_NAMES,
    )(
      "getExampleSkyToolInvocation produces a request that itself parses successfully for %s",
      (toolName) => {
        const example =
          getExampleSkyToolInvocation(
            toolName,
          );

        const parsed =
          parseSkyToolRequest(
            example,
          );

        expect(
          parsed,
        ).not.toBeNull();

        expect(
          parsed?.tool,
        ).toBe(
          toolName,
        );
      },
    );

    it(
      "uses the first of two valid tool blocks and warns",
      () => {
        const warningSpy =
          vi.spyOn(
            console,
            "warn",
          ).mockImplementation(
            () => undefined,
          );

        try {
          const response = [
            "```sky-tool",
            '{"tool":"read_file","args":{"path":"/tmp/first.txt"}}',
            "```",
            "```sky-tool",
            '{"tool":"run_shell_command","args":{"command":"pwd"}}',
            "```",
          ].join("\n");

          expect(
            parseSkyToolRequest(
              response,
            ),
          ).toEqual({
            tool:
              "read_file",
            args: {
              path:
                "/tmp/first.txt",
            },
          });

          expect(
            warningSpy,
          ).toHaveBeenCalledTimes(
            1,
          );

          expect(
            warningSpy,
          ).toHaveBeenCalledWith(
            [
              "Warning: The model returned 2 sky-tool blocks. Only the first was used.",
              "This can happen when the conversation is very long. Consider running /compact.",
              "",
            ].join("\n"),
          );
        } finally {
          warningSpy.mockRestore();
        }
      },
    );

    it(
      "uses the first of three valid tool blocks and warns",
      () => {
        const warningSpy =
          vi.spyOn(
            console,
            "warn",
          ).mockImplementation(
            () => undefined,
          );

        try {
          const response = [
            "```sky-tool",
            '{"tool":"read_file","args":{"path":"/tmp/first.txt"}}',
            "```",
            "```sky-tool",
            '{"tool":"run_shell_command","args":{"command":"pwd"}}',
            "```",
            "```sky-tool",
            '{"tool":"write_file","args":{"path":"/tmp/third.txt","content":"third"}}',
            "```",
          ].join("\n");

          expect(
            parseSkyToolRequest(
              response,
            ),
          ).toEqual({
            tool:
              "read_file",
            args: {
              path:
                "/tmp/first.txt",
            },
          });

          expect(
            warningSpy,
          ).toHaveBeenCalledTimes(
            1,
          );

          expect(
            warningSpy,
          ).toHaveBeenCalledWith(
            [
              "Warning: The model returned 3 sky-tool blocks. Only the first was used.",
              "This can happen when the conversation is very long. Consider running /compact.",
              "",
            ].join("\n"),
          );
        } finally {
          warningSpy.mockRestore();
        }
      },
    );

    it(
      "does not warn for malformed or partial later tool blocks",
      () => {
        const warningSpy =
          vi.spyOn(
            console,
            "warn",
          ).mockImplementation(
            () => undefined,
          );

        try {
          const response = [
            "```sky-tool",
            '{"tool":"read_file","args":{"path":"/tmp/first.txt"}}',
            "```",
            "```sky-tool",
            '{"tool":"run_shell_command","args":',
            "```",
            "```sky-tool",
            '{"tool":"write_file","args":{"path":"/tmp/incomplete.txt","content":"unfinished"}}',
          ].join("\n");

          expect(
            parseSkyToolRequest(
              response,
            ),
          ).toEqual({
            tool:
              "read_file",
            args: {
              path:
                "/tmp/first.txt",
            },
          });

          expect(
            warningSpy,
          ).not.toHaveBeenCalled();
        } finally {
          warningSpy.mockRestore();
        }
      },
    );

    it(
      "adds connected MCP tools to the system prompt",
      () => {
        const prompt =
          createSkyCodeSystemPrompt([
            {
              serverName:
                "test-server",
              name:
                "phase2_ping",
              description:
                "Return a fixed test response.",
              inputSchema: {
                type:
                  "object",
                properties: {},
              },
            },
          ]);

        expect(prompt).toContain(
          'Server "test-server", tool "phase2_ping": Return a fixed test response.',
        );

        expect(prompt).toContain(
          '"tool":"mcp_call"',
        );
      },
    );
  },
);

describe(
  "Sky Code file operations",
  () => {
    let testDirectory: string;

    beforeEach(async () => {
      testDirectory =
        await mkdtemp(
          join(
            tmpdir(),
            "sky-code-basic-test-",
          ),
        );
    });

    afterEach(async () => {
      await rm(
        testDirectory,
        {
          recursive: true,
          force: true,
        },
      );
    });

    it(
      "writes, reads, and edits a text file",
      async () => {
        const writeResult =
          await writeFileToDisk(
            "example.txt",
            "Original text.",
            testDirectory,
          );

        expect(
          writeResult,
        ).toContain(
          "Wrote 14 bytes",
        );

        await expect(
          readFileFromDisk(
            "example.txt",
            testDirectory,
          ),
        ).resolves.toBe(
          "Original text.",
        );

        const editResult =
          await editFileOnDisk(
            "example.txt",
            "Original",
            "Edited",
            testDirectory,
          );

        expect(
          editResult,
        ).toContain(
          "Edited",
        );

        await expect(
          readFileFromDisk(
            "example.txt",
            testDirectory,
          ),
        ).resolves.toBe(
          "Edited text.",
        );
      },
    );

    it(
      "rejects an ambiguous edit",
      async () => {
        await writeFileToDisk(
          "duplicate.txt",
          "same same",
          testDirectory,
        );

        await expect(
          editFileOnDisk(
            "duplicate.txt",
            "same",
            "different",
            testDirectory,
          ),
        ).rejects.toThrow(
          "appears 2 times",
        );
      },
    );
  },
);


it(
  "includes active plugin skills in the system prompt",
  () => {
    const prompt =
      createSkyCodeSystemPrompt(
        [],
        [
          {
            name:
              "review-code",
            description:
              "Review supplied code",
            prompt:
              "Identify concrete correctness problems.",
            command:
              "/review",
            pluginName:
              "review-plugin",
            pluginDirectory:
              "/tmp/review-plugin",
            source:
              "project",
          },
        ],
      );

    expect(
      prompt,
    ).toContain(
      'Active plugin skills:',
    );

    expect(
      prompt,
    ).toContain(
      '- /review from plugin "review-plugin": Review supplied code',
    );

    expect(
      prompt,
    ).toContain(
      'Instructions: Identify concrete correctness problems.',
    );
  },
);


it(
  "appends sky.md content to the end of the system prompt when provided",
  () => {
    const prompt =
      createSkyCodeSystemPrompt(
        [],
        [],
        [],
        [],
        "Confirm before destructive actions.",
      );

    const skyMdHeaderIndex =
      prompt.indexOf(
        "User-defined operating rules (~/.sky-code/sky.md):",
      );

    expect(
      skyMdHeaderIndex,
    ).toBeGreaterThan(
      -1,
    );

    expect(
      prompt,
    ).toContain(
      "Confirm before destructive actions.",
    );

    // sky.md content must land after the delegation example, the last
    // built-in section, so recency-weighting benefits still apply for
    // smaller models.
    const delegationExampleIndex =
      prompt.indexOf(
        "Sub-agent delegation example:",
      );

    expect(
      skyMdHeaderIndex,
    ).toBeGreaterThan(
      delegationExampleIndex,
    );
  },
);

it(
  "omits the sky.md section entirely when content is empty or whitespace-only",
  () => {
    const promptWithNoArg =
      createSkyCodeSystemPrompt();

    const promptWithBlankSkyMd =
      createSkyCodeSystemPrompt(
        [],
        [],
        [],
        [],
        "   \n  ",
      );

    for (const prompt of [
      promptWithNoArg,
      promptWithBlankSkyMd,
    ]) {
      expect(
        prompt,
      ).not.toContain(
        "User-defined operating rules",
      );
    }
  },
);


describe(
  "delegate_to_agent tool protocol",
  () => {
    it(
      "parses an agent delegation request with context",
      () => {
        const request =
          parseSkyToolRequest(
            [
              "```sky-tool",
              JSON.stringify({
                tool:
                  "delegate_to_agent",
                args: {
                  agent:
                    "code-reviewer",
                  task:
                    "Review the configuration.",
                  context:
                    "Focus on config/defaults.json.",
                },
              }),
              "```",
            ].join("\n"),
          );

        expect(
          request,
        ).toEqual({
          tool:
            "delegate_to_agent",
          args: {
            agent:
              "code-reviewer",
            task:
              "Review the configuration.",
            context:
              "Focus on config/defaults.json.",
          },
        });
      },
    );

    it(
      "parses an agent delegation request without context",
      () => {
        const request =
          parseSkyToolRequest(
            [
              "```sky-tool",
              JSON.stringify({
                tool:
                  "delegate_to_agent",
                args: {
                  agent:
                    "test-writer",
                  task:
                    "Write focused tests.",
                },
              }),
              "```",
            ].join("\n"),
          );

        expect(
          request,
        ).toEqual({
          tool:
            "delegate_to_agent",
          args: {
            agent:
              "test-writer",
            task:
              "Write focused tests.",
          },
        });
      },
    );

    it(
      "rejects an invalid delegation context",
      () => {
        expect(
          () =>
            parseSkyToolRequest(
              [
                "```sky-tool",
                JSON.stringify({
                  tool:
                    "delegate_to_agent",
                  args: {
                    agent:
                      "reviewer",
                    task:
                      "Review the task.",
                    context:
                      42,
                  },
                }),
                "```",
              ].join("\n"),
            ),
        ).toThrow(
          'Tool argument "context" must be a string',
        );
      },
    );

    it(
      "returns a clear result when no agent handler is active",
      async () => {
        const result =
          await executeSkyToolRequest(
            {
              tool:
                "delegate_to_agent",
              args: {
                agent:
                  "reviewer",
                task:
                  "Review the task.",
              },
            },
            {
              async read_file() {
                throw new Error(
                  "Unexpected read_file call",
                );
              },

              async write_file() {
                throw new Error(
                  "Unexpected write_file call",
                );
              },

              async edit_file() {
                throw new Error(
                  "Unexpected edit_file call",
                );
              },

              async run_shell_command() {
                throw new Error(
                  "Unexpected run_shell_command call",
                );
              },
            },
          );

        expect(
          result,
        ).toEqual({
          success:
            false,
          output:
            "No sub-agent handler is active in this Sky Code session.",
        });
      },
    );

    it(
      "includes active sub-agents in the system prompt",
      () => {
        const prompt =
          createSkyCodeSystemPrompt(
            [],
            [],
            [
              {
                name:
                  "reviewer",
                description:
                  "Reviews delegated work",
                systemPrompt:
                  "Review the delegated task.",
                pluginName:
                  "agent-plugin",
                pluginDirectory:
                  "/tmp/agent-plugin/.sky-code-plugin",
                source:
                  "project",
              },
            ],
          );

        expect(
          prompt,
        ).toContain(
          "- delegate_to_agent(agent, task, context?): Run one task in a separate sub-agent worker process",
        );

        expect(
          prompt,
        ).toContain(
          '- "reviewer" from plugin "agent-plugin": Reviews delegated work (uses the current Sky Code model)',
        );

        expect(
          prompt,
        ).toContain(
          '"tool":"delegate_to_agent"',
        );
      },
    );
  },
);

describe(
  "Phase 2 core behavior",
  () => {
    it(
      "fires PreToolUse and PostToolUse around a real tool handler",
      async () => {
        const registry =
          new HookRegistry();

        const executionOrder:
          string[] = [];

        registry.register(
          "PreToolUse",
          (
            event,
          ) => {
            executionOrder.push(
              "PreToolUse",
            );

            event.metadata
              .verifiedByPreHook =
              true;
          },
          {
            source:
              "basic-phase2-pre-hook",
          },
        );

        registry.register(
          "PostToolUse",
          (
            event,
          ) => {
            executionOrder.push(
              "PostToolUse",
            );

            expect(
              event.metadata
                .verifiedByPreHook,
            ).toBe(
              true,
            );

            expect(
              event.result,
            ).toEqual({
              success:
                true,
              output:
                "Phase 2 hook test read completed.",
            });
          },
          {
            source:
              "basic-phase2-post-hook",
          },
        );

        const result =
          await executeSkyToolRequestWithHooks(
            {
              tool:
                "read_file",
              args: {
                path:
                  "phase2-test.txt",
              },
            },
            {
              async read_file(
                args,
              ) {
                executionOrder.push(
                  "handler",
                );

                expect(
                  args.path,
                ).toBe(
                  "phase2-test.txt",
                );

                return {
                  success:
                    true,
                  output:
                    "Phase 2 hook test read completed.",
                };
              },

              async write_file() {
                throw new Error(
                  "Unexpected write_file call",
                );
              },

              async edit_file() {
                throw new Error(
                  "Unexpected edit_file call",
                );
              },

              async run_shell_command() {
                throw new Error(
                  "Unexpected run_shell_command call",
                );
              },
            },
            registry,
          );

        expect(
          result,
        ).toEqual({
          success:
            true,
          output:
            "Phase 2 hook test read completed.",
        });

        expect(
          executionOrder,
        ).toEqual([
          "PreToolUse",
          "handler",
          "PostToolUse",
        ]);
      },
    );

    it(
      "changes the active permission mode immediately",
      () => {
        const controller =
          new PermissionController(
            "default",
          );

        expect(
          controller.getMode(),
        ).toBe(
          "default",
        );

        controller.setMode(
          "auto-accept-edits",
        );

        expect(
          controller.getMode(),
        ).toBe(
          "auto-accept-edits",
        );

        controller.setMode(
          "plan",
        );

        expect(
          controller.getMode(),
        ).toBe(
          "plan",
        );

        controller.setMode(
          "bypass",
        );

        expect(
          controller.getMode(),
        ).toBe(
          "bypass",
        );
      },
    );

    it(
      "compacts older context and fires both compact hooks",
      async () => {
        const messages:
          ChatMessage[] =
            Array.from(
              {
                length:
                  8,
              },
              (
                _,
                index,
              ) => ({
                role:
                  index % 2 ===
                    0
                    ? "user"
                    : "assistant",
                content:
                  `Phase 2 message ${index + 1}`,
              }),
            );

        const registry =
          new HookRegistry();

        const hookOrder:
          string[] = [];

        registry.register(
          "PreCompact",
          (
            event,
          ) => {
            hookOrder.push(
              "PreCompact",
            );

            expect(
              event.messageCount,
            ).toBe(
              8,
            );

            expect(
              event.reason,
            ).toBe(
              "manual",
            );
          },
        );

        registry.register(
          "PostCompact",
          (
            event,
          ) => {
            hookOrder.push(
              "PostCompact",
            );

            expect(
              event.beforeMessageCount,
            ).toBe(
              8,
            );

            expect(
              event.afterMessageCount,
            ).toBe(
              5,
            );
          },
        );

        const result =
          await compactConversation(
            messages,
            {
              reason:
                "manual",
              keepRecentMessages:
                4,
              hookRegistry:
                registry,
              summarize:
                async () =>
                  "The earlier Phase 2 test messages were summarized.",
            },
          );

        expect(
          result,
        ).toMatchObject({
          compacted:
            true,
          reason:
            "manual",
          beforeMessageCount:
            8,
          afterMessageCount:
            5,
        });

        expect(
          hookOrder,
        ).toEqual([
          "PreCompact",
          "PostCompact",
        ]);

        expect(
          messages,
        ).toHaveLength(
          5,
        );

        expect(
          messages[0]
            ?.content,
        ).toContain(
          "The earlier Phase 2 test messages were summarized.",
        );

        expect(
          messages.slice(
            1,
          ),
        ).toEqual([
          {
            role:
              "user",
            content:
              "Phase 2 message 5",
          },
          {
            role:
              "assistant",
            content:
              "Phase 2 message 6",
          },
          {
            role:
              "user",
            content:
              "Phase 2 message 7",
          },
          {
            role:
              "assistant",
            content:
              "Phase 2 message 8",
          },
        ]);
      },
    );
  },
);

describe(
  "Phase 3 core behavior",
  () => {
    it(
      "resolves a catalog prompt command with supplied arguments",
      async () => {
        const {
          resolveCatalogCommand,
        } =
          await import(
            "../src/catalog-runtime.ts"
          );

        const resolved =
          resolveCatalogCommand(
            "/phase3-review src/index.ts",
            [
              {
                type:
                  "command",

                name:
                  "/phase3-review",

                description:
                  "Review a source file",

                prompt:
                  "Review {{file}} carefully.",

                source:
                  "catalog",

                filePath:
                  "/tmp/phase3-review.json",
              },
            ],
          );

        expect(
          resolved,
        ).toMatchObject({
          kind:
            "prompt",

          commandArguments:
            "src/index.ts",

          conversationInput:
            "Review src/index.ts carefully.",
        });
      },
    );

    it(
      "parses catalog management and history commands",
      async () => {
        const {
          parseCatalogManagementCommand,
        } =
          await import(
            "../src/catalog-management.ts"
          );

        const {
          parseHistoryCommand,
        } =
          await import(
            "../src/history.ts"
          );

        expect(
          parseCatalogManagementCommand(
            "/catalog enable careful-review",
          ),
        ).toEqual({
          action:
            "enable",

          name:
            "careful-review",
        });

        expect(
          parseHistoryCommand(
            "/history search exact codeword",
          ),
        ).toEqual({
          action:
            "search",

          term:
            "exact codeword",
        });
      },
    );

    it(
      "recognizes resume, fresh, and default session choices",
      async () => {
        const {
          parseSessionResumeSelection,
        } =
          await import(
            "../src/session-resume-prompt.ts"
          );

        expect(
          parseSessionResumeSelection(
            "1",
          ),
        ).toBe(
          "resume",
        );

        expect(
          parseSessionResumeSelection(
            "2",
          ),
        ).toBe(
          "fresh",
        );

        expect(
          parseSessionResumeSelection(
            "",
          ),
        ).toBe(
          "fresh",
        );
      },
    );

    it(
      "accepts a healthy LiteLLM model list at startup",
      async () => {
        const {
          runStartupHealthCheck,
        } =
          await import(
            "../src/startup-health.ts"
          );

        await expect(
          runStartupHealthCheck(
            {
              apiUrl:
                "http://litellm.test/v1",

              apiKey:
                "temporary-phase3-key",

              defaultModel:
                "phase3-model",

              defaultPermissionMode:
                "default",

              compactionThreshold:
                6_000,

              compactionStrategy:
                "summarise",

              compactionWindowSize:
                20,

              mcpServers: [],

              pluginDirs: [],
            },
            async () => [
              "phase3-model",
            ],
          ),
        ).resolves.toEqual({
          defaultModel:
            "phase3-model",

          models: [
            "phase3-model",
          ],
        });
      },
    );

    it(
      "formats actionable errors without exposing credentials",
      async () => {
        const {
          formatCliErrorReport,
        } =
          await import(
            "../src/error-reporting.ts"
          );

        const report =
          formatCliErrorReport(
            new Error(
              "LITELLM_API_KEY=phase3-secret-key",
            ),
            {
              operation:
                "Phase 3 validation",
            },
          );

        expect(
          report[0],
        ).toBe(
          "Phase 3 validation failed.",
        );

        expect(
          report.join(
            "\n",
          ),
        ).not.toContain(
          "phase3-secret-key",
        );
      },
    );
  },
);
