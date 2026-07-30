import {
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
  HookRegistry,
} from "../src/hooks.ts";

function createMessages():
  ChatMessage[] {
  return [
    {
      role:
        "user",

      content:
        `Old request ${"A".repeat(
          200,
        )}`,
    },
    {
      role:
        "assistant",

      content:
        `Old response ${"B".repeat(
          200,
        )}`,
    },
    {
      role:
        "user",

      content: [
        "Sky Code tool result for read_file:",
        `STALE ${"C".repeat(
          400,
        )}`,
      ].join(
        "\n",
      ),
    },
    {
      role:
        "assistant",

      content:
        `Older response ${"D".repeat(
          200,
        )}`,
    },
    {
      role:
        "user",

      content:
        `Older follow-up ${"E".repeat(
          200,
        )}`,
    },
    {
      role:
        "assistant",

      content:
        "Recent response one",
    },
    {
      role:
        "user",

      content:
        "Recent request two",
    },
    {
      role:
        "assistant",

      content:
        "Recent response two",
    },
  ];
}

describe(
  "compaction strategies",
  () => {
    it(
      "retains only the configured window for sliding-window compaction",
      async () => {
        const messages =
          createMessages();

        const expectedRecentMessages =
          messages
            .slice(
              -3,
            )
            .map(
              (
                message,
              ) => ({
                ...message,
              }),
            );

        const summarizer =
          vi.fn(
            async () =>
              "This must not be called.",
          );

        const hookOrder:
          string[] = [];

        const registry =
          new HookRegistry();

        registry.register(
          "PreCompact",
          (
            event,
          ) => {
            hookOrder.push(
              "pre",
            );

            expect(
              event.metadata
                .strategy,
            ).toBe(
              "sliding-window",
            );
          },
        );

        registry.register(
          "PostCompact",
          (
            event,
          ) => {
            hookOrder.push(
              "post",
            );

            expect(
              event.summary,
            ).toBeUndefined();

            expect(
              event.metadata
                .estimatedTokenReduction,
            ).toBeGreaterThan(
              0,
            );
          },
        );

        const result =
          await compactConversation(
            messages,
            {
              reason:
                "manual",

              strategy:
                "sliding-window",

              keepRecentMessages:
                3,

              hookRegistry:
                registry,

              summarize:
                summarizer,
            },
          );

        expect(
          summarizer,
        ).not.toHaveBeenCalled();

        expect(
          hookOrder,
        ).toEqual([
          "pre",
          "post",
        ]);

        expect(
          messages,
        ).toEqual(
          expectedRecentMessages,
        );

        expect(
          result,
        ).toMatchObject({
          compacted:
            true,

          strategy:
            "sliding-window",

          beforeMessageCount:
            8,

          afterMessageCount:
            3,

          compactedTurnCount:
            5,

          droppedToolOutputCount:
            1,
        });

        expect(
          result.summary,
        ).toBeUndefined();

        expect(
          result
            .estimatedTokenReduction,
        ).toBeGreaterThan(
          0,
        );
      },
    );

    it(
      "keeps summarise as the default strategy",
      async () => {
        const messages =
          createMessages();

        const result =
          await compactConversation(
            messages,
            {
              reason:
                "manual",

              keepRecentMessages:
                3,

              hookRegistry:
                new HookRegistry(),

              summarize:
                async () =>
                  "Earlier work was summarized.",
            },
          );

        expect(
          result,
        ).toMatchObject({
          compacted:
            true,

          strategy:
            "summarise",

          beforeMessageCount:
            8,

          afterMessageCount:
            4,

          compactedTurnCount:
            4,

          summary:
            "Earlier work was summarized.",
        });

        expect(
          messages[0]
            ?.content,
        ).toContain(
          "Earlier work was summarized.",
        );
      },
    );

    it(
      "restores sliding-window history when PostCompact fails",
      async () => {
        const messages =
          createMessages();

        const originalMessages =
          messages.map(
            (
              message,
            ) => ({
              ...message,
            }),
          );

        const registry =
          new HookRegistry();

        registry.register(
          "PostCompact",
          () => {
            throw new Error(
              "sliding-window post hook failed",
            );
          },
          {
            source:
              "sliding-window-test-hook",
          },
        );

        await expect(
          compactConversation(
            messages,
            {
              reason:
                "token-pressure",

              strategy:
                "sliding-window",

              keepRecentMessages:
                3,

              hookRegistry:
                registry,
            },
          ),
        ).rejects.toThrow(
          "sliding-window post hook failed",
        );

        expect(
          messages,
        ).toEqual(
          originalMessages,
        );
      },
    );
  },
);
