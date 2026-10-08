import {
  readFile,
} from "node:fs/promises";

import {
  join,
} from "node:path";

import {
  describe,
  expect,
  it,
} from "vitest";

import {
  withNativeActivityIndicator,
  withTextActivityIndicator,
} from "../src/agent/adapters/activity-indicator.ts";

import {
  NativeStrategy,
} from "../src/agent/strategies/native.ts";

import type {
  NativeCompletionClient,
  NativeCompletionRequest,
  NativeCompletionResult,
  TextCompletionClient,
} from "../src/agent/model-client.ts";

/**
 * A fake indicator that records the order of start/stop events relative to
 * the wrapped request, so tests can assert it runs for exactly the
 * request's lifetime.
 */
function recordingIndicator(
  log: string[],
) {
  let starts = 0;

  return () => {
    starts += 1;
    const id = starts;

    log.push(`start ${id}`);

    let stopped = false;

    return () => {
      if (stopped) {
        return;
      }

      stopped = true;
      log.push(`stop ${id}`);
    };
  };
}

const REQUEST: NativeCompletionRequest = {
  model: "m",
  systemPrompt: "s",
  turns: [
    {
      role: "user",
      content: "hi",
    },
  ],
  tools: [],
  parallelToolCalls: false,
};

describe(
  "agent/adapters/activity-indicator.ts",
  () => {
    it(
      "shows the indicator for exactly the lifetime of a text request and passes everything through unchanged",
      async () => {
        const log: string[] = [];

        const inner: TextCompletionClient = {
          async complete(
            model,
            systemPrompt,
            turns,
            options,
          ) {
            log.push("request");

            return JSON.stringify({
              model,
              systemPrompt,
              turns,
              options,
            });
          },
        };

        const wrapped =
          withTextActivityIndicator(
            inner,
            recordingIndicator(log),
          );

        const result =
          await wrapped.complete(
            "m",
            "s",
            [
              {
                role: "user",
                content: "hi",
              },
            ],
            {
              jsonMode: true,
            },
          );

        expect(log).toEqual([
          "start 1",
          "request",
          "stop 1",
        ]);

        expect(
          JSON.parse(result),
        ).toEqual({
          model: "m",
          systemPrompt: "s",
          turns: [
            {
              role: "user",
              content: "hi",
            },
          ],
          options: {
            jsonMode: true,
          },
        });
      },
    );

    it(
      "shows the indicator for exactly the lifetime of a native request and returns its result unchanged",
      async () => {
        const log: string[] = [];

        const result: NativeCompletionResult = {
          content: null,
          toolCalls: [
            {
              id: "call_1",
              name: "read_file",
              argumentsJson: '{"path":"a.txt"}',
            },
          ],
          protocolNotes: [
            "note",
          ],
        };

        const received: NativeCompletionRequest[] = [];

        const inner: NativeCompletionClient = {
          async complete(request) {
            log.push("request");
            received.push(request);

            return result;
          },
        };

        const wrapped =
          withNativeActivityIndicator(
            inner,
            recordingIndicator(log),
          );

        expect(
          await wrapped.complete(
            REQUEST,
          ),
        ).toBe(result);

        expect(received).toEqual([
          REQUEST,
        ]);

        expect(log).toEqual([
          "start 1",
          "request",
          "stop 1",
        ]);
      },
    );

    it.each([
      [
        "text",
        (fail: Error, log: string[]) =>
          withTextActivityIndicator(
            {
              async complete() {
                throw fail;
              },
            },
            recordingIndicator(log),
          ).complete(
            "m",
            "s",
            [],
          ),
      ],
      [
        "native",
        (fail: Error, log: string[]) =>
          withNativeActivityIndicator(
            {
              async complete() {
                throw fail;
              },
            },
            recordingIndicator(log),
          ).complete(
            REQUEST,
          ),
      ],
    ])(
      "stops the indicator when a %s request throws, and rethrows the same error",
      async (_label, run) => {
        const log: string[] = [];

        const failure =
          new Error(
            "LiteLLM native tool-calling request failed: HTTP 503: unavailable",
          );

        await expect(
          run(
            failure,
            log,
          ),
        ).rejects.toBe(
          failure,
        );

        expect(log).toEqual([
          "start 1",
          "stop 1",
        ]);
      },
    );

    it(
      "runs one indicator per request, including NativeStrategy's corrective retries",
      async () => {
        const log: string[] = [];

        const script: NativeCompletionResult[] = [
          {
            content: null,
            // Two calls in one response: none runs, and NativeStrategy
            // asks again (a corrective retry).
            toolCalls: [
              {
                id: "a",
                name: "write_file",
                argumentsJson: "{}",
              },
              {
                id: "b",
                name: "write_file",
                argumentsJson: "{}",
              },
            ],
          },
          {
            content: "Done.",
            toolCalls: [],
          },
        ];

        let index = 0;

        const inner: NativeCompletionClient = {
          async complete() {
            log.push("request");

            const next =
              script[index]!;

            index += 1;

            return next;
          },
        };

        const strategy =
          new NativeStrategy(
            withNativeActivityIndicator(
              inner,
              recordingIndicator(log),
            ),
            "system prompt",
          );

        await strategy.getNextAction(
          {
            priorTurns: [],
            goal: "write a file",
            history: [],
          },
          [
            {
              name: "write_file",
              description: "Writes a file.",
              parameters: {
                type: "object",
                properties: {},
              },
              examples: [],
              permissionCategory: "write-file",
            },
          ],
          "m",
        );

        expect(log).toEqual([
          "start 1",
          "request",
          "stop 1",
          "start 2",
          "request",
          "stop 2",
        ]);
      },
    );

    it(
      "is wired in index.ts around both the silent prompted client and the native client, using the existing spinner",
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

        expect(source).toContain(
          [
            "  const silentTextClient =",
            "    withTextActivityIndicator(",
            "      createLiteLLMTextCompletionClient(",
            "        config,",
            "      ),",
            "      startThinkingIndicator,",
            "    );",
          ].join("\n"),
        );

        expect(source).toContain(
          [
            "  const nativeClient =",
            "    withNativeActivityIndicator(",
            "      createLiteLLMNativeCompletionClient(",
            "        config,",
            "        resolveNativeTransport,",
            "      ),",
            "      startThinkingIndicator,",
            "    );",
          ].join("\n"),
        );
      },
    );
  },
);
