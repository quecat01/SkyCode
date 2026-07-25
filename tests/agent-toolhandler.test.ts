import {
  fileURLToPath,
} from "node:url";

import {
  describe,
  expect,
  it,
} from "vitest";

import type {
  ActiveSubAgentDefinition,
} from "../src/agents.ts";

import {
  createSkyCodeToolHandlers,
} from "../src/toolhandlers.ts";

const workerPath =
  fileURLToPath(
    new URL(
      "./fixtures/agent-test-worker.mjs",
      import.meta.url,
    ),
  );

function createAgent(
  overrides:
    Partial<
      ActiveSubAgentDefinition
    > = {},
): ActiveSubAgentDefinition {
  return {
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
    ...overrides,
  };
}

describe(
  "delegated-agent tool handler",
  () => {
    it(
      "runs a delegated task in the worker using the active model",
      async () => {
        const handlers =
          createSkyCodeToolHandlers(
            "/tmp",
            [],
            {
              agents: [
                createAgent(),
              ],
              apiUrl:
                "http://unused.test/v1",
              apiKey:
                "test-key",
              getActiveModel:
                () =>
                  "current-model",
              workerPath,
              timeoutMs:
                5000,
            },
          );

        const result =
          await handlers
            .delegate_to_agent?.({
              agent:
                "reviewer",
              task:
                "Review the configuration.",
              context:
                "Focus on defaults.json.",
            });

        expect(
          result?.success,
        ).toBe(true);

        const output =
          JSON.parse(
            result?.output ??
              "",
          );

        expect(
          output,
        ).toMatchObject({
          agentName:
            "reviewer",
          model:
            "current-model",
          task:
            "Review the configuration.",
          context:
            "Focus on defaults.json.",
        });

        expect(
          output,
        ).toHaveProperty(
          "systemPrompt",
          "Review the delegated task.",
        );
      },
    );

    it(
      "uses the agent model override instead of the active model",
      async () => {
        const handlers =
          createSkyCodeToolHandlers(
            "/tmp",
            [],
            {
              agents: [
                createAgent({
                  model:
                    "review-model",
                }),
              ],
              apiUrl:
                "http://unused.test/v1",
              apiKey:
                "test-key",
              getActiveModel:
                () =>
                  "current-model",
              workerPath,
              timeoutMs:
                5000,
            },
          );

        const result =
          await handlers
            .delegate_to_agent?.({
              agent:
                "reviewer",
              task:
                "Use the override.",
            });

        expect(
          result?.success,
        ).toBe(true);

        const output =
          JSON.parse(
            result?.output ??
              "",
          );

        expect(
          output.model,
        ).toBe(
          "review-model",
        );
      },
    );

    it(
      "returns the available names when the requested agent is unknown",
      async () => {
        const handlers =
          createSkyCodeToolHandlers(
            "/tmp",
            [],
            {
              agents: [
                createAgent(),
                createAgent({
                  name:
                    "tester",
                }),
              ],
              apiUrl:
                "http://unused.test/v1",
              apiKey:
                "test-key",
              getActiveModel:
                () =>
                  "current-model",
              workerPath,
            },
          );

        const result =
          await handlers
            .delegate_to_agent?.({
              agent:
                "missing-agent",
              task:
                "This must not run.",
            });

        expect(
          result,
        ).toEqual({
          success:
            false,
          output:
            'Sub-agent "missing-agent" is not active. Available sub-agents: reviewer, tester.',
        });
      },
    );

    it(
      "returns worker failures as unsuccessful tool results",
      async () => {
        const handlers =
          createSkyCodeToolHandlers(
            "/tmp",
            [],
            {
              agents: [
                createAgent(),
              ],
              apiUrl:
                "http://unused.test/v1",
              apiKey:
                "test-key",
              getActiveModel:
                () =>
                  "current-model",
              workerPath,
              timeoutMs:
                5000,
            },
          );

        const result =
          await handlers
            .delegate_to_agent?.({
              agent:
                "reviewer",
              task:
                "__FAIL__",
            });

        expect(
          result?.success,
        ).toBe(false);

        expect(
          result?.output,
        ).toContain(
          "Intentional test failure",
        );
      },
    );
  },
);
