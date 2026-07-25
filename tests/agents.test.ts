import {
  fileURLToPath,
} from "node:url";

import {
  describe,
  expect,
  it,
} from "vitest";

import {
  formatSubAgentsForPrompt,
  mergePluginAgents,
  runSubAgentTask,
  type AgentRuntimeConfig,
  type SubAgentDefinition,
} from "../src/agents.ts";

import {
  HookRegistry,
} from "../src/hooks.ts";

import type {
  LoadedPlugin,
} from "../src/plugins.ts";

const workerPath =
  fileURLToPath(
    new URL(
      "./fixtures/agent-test-worker.mjs",
      import.meta.url,
    ),
  );

const runtimeConfig:
  AgentRuntimeConfig = {
  apiUrl:
    "http://litellm.test/v1",
  apiKey:
    "test-key",
  defaultModel:
    "default-test-model",
};

function createDefinition():
  SubAgentDefinition {
  return {
    name:
      "test-agent",
    description:
      "A deterministic test agent",
    systemPrompt:
      "Complete the delegated test task.",
  };
}

describe(
  "sub-agent worker framework",
  () => {
    it(
      "delegates a task and context to a separate process",
      async () => {
        const result =
          await runSubAgentTask(
            {
              ...createDefinition(),
              model:
                "agent-model",
            },
            {
              task:
                "Review the configuration.",
              context:
                "Only inspect JSON files.",
            },
            runtimeConfig,
            {
              workerPath,
              timeoutMs:
                5000,
            },
          );

        const output =
          JSON.parse(
            result.output,
          );

        expect(
          output,
        ).toEqual({
          agentName:
            "test-agent",
          description:
            "A deterministic test agent",
          systemPrompt:
            "Complete the delegated test task.",
          model:
            "agent-model",
          task:
            "Review the configuration.",
          context:
            "Only inspect JSON files.",
        });

        expect(
          result.workerPid,
        ).not.toBe(
          process.pid,
        );

        expect(
          result.model,
        ).toBe(
          "agent-model",
        );
      },
    );

    it(
      "uses the default model when the agent has no override",
      async () => {
        const result =
          await runSubAgentTask(
            createDefinition(),
            {
              task:
                "Use the default model.",
            },
            runtimeConfig,
            {
              workerPath,
              timeoutMs:
                5000,
            },
          );

        expect(
          result.model,
        ).toBe(
          "default-test-model",
        );
      },
    );

    it(
      "fires start and completion notifications",
      async () => {
        const registry =
          new HookRegistry();

        const events:
          Array<{
            level: string;
            message: string;
            metadata:
              Record<string, unknown>;
          }> = [];

        registry.register(
          "Notification",
          (
            event,
          ) => {
            events.push({
              level:
                event.level,
              message:
                event.message,
              metadata: {
                ...event.metadata,
              },
            });
          },
          {
            source:
              "agent-test",
          },
        );

        await runSubAgentTask(
          createDefinition(),
          {
            task:
              "Emit notifications.",
          },
          runtimeConfig,
          {
            workerPath,
            timeoutMs:
              5000,
            hookRegistry:
              registry,
          },
        );

        expect(
          events.map(
            (
              event,
            ) =>
              event.metadata
                .event,
          ),
        ).toEqual([
          "sub_agent_started",
          "sub_agent_completed",
        ]);

        expect(
          events.map(
            (
              event,
            ) =>
              event.level,
          ),
        ).toEqual([
          "info",
          "info",
        ]);

        expect(
          events[0]?.message,
        ).toBe(
          'Sub-agent "test-agent" started.',
        );

        expect(
          events[1]?.message,
        ).toBe(
          'Sub-agent "test-agent" completed.',
        );
      },
    );

    it(
      "reports worker failures and fires an error notification",
      async () => {
        const registry =
          new HookRegistry();

        const notificationEvents:
          unknown[] = [];

        registry.register(
          "Notification",
          (
            event,
          ) => {
            notificationEvents.push(
              event.metadata
                .event,
            );
          },
        );

        await expect(
          runSubAgentTask(
            createDefinition(),
            {
              task:
                "__FAIL__",
            },
            runtimeConfig,
            {
              workerPath,
              timeoutMs:
                5000,
              hookRegistry:
                registry,
            },
          ),
        ).rejects.toThrow(
          'Sub-agent "test-agent" failed: Intentional test failure',
        );

        expect(
          notificationEvents,
        ).toEqual([
          "sub_agent_started",
          "sub_agent_failed",
        ]);
      },
    );

    it(
      "terminates workers that exceed the timeout",
      async () => {
        await expect(
          runSubAgentTask(
            createDefinition(),
            {
              task:
                "__HANG__",
            },
            runtimeConfig,
            {
              workerPath,
              timeoutMs:
                100,
            },
          ),
        ).rejects.toThrow(
          'Sub-agent "test-agent" timed out after 100 ms.',
        );
      },
    );

    it(
      "rejects invalid definitions and tasks before forking",
      async () => {
        await expect(
          runSubAgentTask(
            {
              ...createDefinition(),
              name:
                "",
            },
            {
              task:
                "Valid task",
            },
            runtimeConfig,
            {
              workerPath,
            },
          ),
        ).rejects.toThrow(
          "Sub-agent name must be a non-empty string",
        );

        await expect(
          runSubAgentTask(
            createDefinition(),
            {
              task:
                "   ",
            },
            runtimeConfig,
            {
              workerPath,
            },
          ),
        ).rejects.toThrow(
          "Delegated task must be a non-empty string",
        );
      },
    );
  },
);


describe(
  "plugin sub-agent definitions",
  () => {
    function createPlugin(
      name: string,
      agents: unknown[],
    ): LoadedPlugin {
      return {
        name,
        version:
          "1.0.0",
        description:
          "Agent test plugin",
        skills: [],
        agents,
        hooks: [],
        mcpServers: [],
        directory:
          `/tmp/${name}/.sky-code-plugin`,
        manifestPath:
          `/tmp/${name}/.sky-code-plugin/plugin.json`,
        source:
          "project",
      };
    }

    it(
      "validates and merges plugin agents",
      () => {
        const agents =
          mergePluginAgents([
            createPlugin(
              "review-plugin",
              [
                {
                  name:
                    "code-reviewer",
                  description:
                    "Reviews code",
                  systemPrompt:
                    "Report concrete correctness problems.",
                  model:
                    "review-model",
                },
              ],
            ),

            createPlugin(
              "test-plugin",
              [
                {
                  name:
                    "test-writer",
                  description:
                    "Writes focused tests",
                  systemPrompt:
                    "Create tests for the delegated task.",
                },
              ],
            ),
          ]);

        expect(
          agents.map(
            (
              agent,
            ) =>
              agent.name,
          ),
        ).toEqual([
          "code-reviewer",
          "test-writer",
        ]);

        expect(
          agents[0],
        ).toMatchObject({
          name:
            "code-reviewer",
          model:
            "review-model",
          pluginName:
            "review-plugin",
          source:
            "project",
        });

        expect(
          agents[1]?.model,
        ).toBeUndefined();
      },
    );

    it(
      "rejects duplicate agent names",
      () => {
        expect(
          () =>
            mergePluginAgents([
              createPlugin(
                "first-plugin",
                [
                  {
                    name:
                      "reviewer",
                    description:
                      "First reviewer",
                    systemPrompt:
                      "Review the task.",
                  },
                ],
              ),

              createPlugin(
                "second-plugin",
                [
                  {
                    name:
                      "reviewer",
                    description:
                      "Second reviewer",
                    systemPrompt:
                      "Review the task differently.",
                  },
                ],
              ),
            ]),
        ).toThrow(
          'Duplicate sub-agent name "reviewer" in plugins "first-plugin" and "second-plugin"',
        );
      },
    );

    it(
      "rejects malformed plugin agent definitions",
      () => {
        expect(
          () =>
            mergePluginAgents([
              createPlugin(
                "invalid-plugin",
                [
                  {
                    name:
                      "Invalid Agent",
                    description:
                      "Invalid name",
                    systemPrompt:
                      "Review the task.",
                  },
                ],
              ),
            ]),
        ).toThrow(
          "may contain only lowercase letters, digits, hyphens, and underscores",
        );

        expect(
          () =>
            mergePluginAgents([
              createPlugin(
                "missing-prompt",
                [
                  {
                    name:
                      "reviewer",
                    description:
                      "Missing prompt",
                  },
                ],
              ),
            ]),
        ).toThrow(
          "agents[0].systemPrompt must be a non-empty string",
        );
      },
    );

    it(
      "formats active agents for the model prompt",
      () => {
        const agents =
          mergePluginAgents([
            createPlugin(
              "agent-plugin",
              [
                {
                  name:
                    "reviewer",
                  description:
                    "Reviews delegated work",
                  systemPrompt:
                    "Review the delegated task.",
                  model:
                    "review-model",
                },

                {
                  name:
                    "tester",
                  description:
                    "Creates delegated tests",
                  systemPrompt:
                    "Create focused tests.",
                },
              ],
            ),
          ]);

        expect(
          formatSubAgentsForPrompt(
            agents,
          ),
        ).toEqual([
          "",
          "Active sub-agents:",
          '- "reviewer" from plugin "agent-plugin": Reviews delegated work (uses model "review-model")',
          '- "tester" from plugin "agent-plugin": Creates delegated tests (uses the current Sky Code model)',
        ]);
      },
    );

    it(
      "reports when no sub-agents are active",
      () => {
        expect(
          formatSubAgentsForPrompt(
            [],
          ),
        ).toEqual([
          "",
          "No sub-agents are active in this session.",
        ]);
      },
    );
  },
);
