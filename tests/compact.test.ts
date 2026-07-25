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
  createCompactionSummaryMessage,
} from "../src/compact.ts";

import {
  HookRegistry,
} from "../src/hooks.ts";

function createMessages(
  count: number,
): ChatMessage[] {
  return Array.from(
    {
      length:
        count,
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
        `Message ${index + 1}`,
    }),
  );
}

describe(
  "context compaction",
  () => {
    it(
      "summarizes older messages, removes stale tool output, and preserves recent messages",
      async () => {
        const messages:
          ChatMessage[] = [
          {
            role:
              "user",
            content:
              "Old user request",
          },
          {
            role:
              "assistant",
            content:
              "Old assistant response",
          },
          {
            role:
              "assistant",
            content:
              [
                "```sky-tool",
                '{"tool":"read_file","args":{"path":"/tmp/large.txt"}}',
                "```",
              ].join(
                "\n",
              ),
          },
          {
            role:
              "user",
            content: [
              "Sky Code tool result for read_file:",
              "{",
              '  "success": true,',
              '  "output": "VERY LARGE STALE TOOL OUTPUT"',
              "}",
            ].join(
              "\n",
            ),
          },
          {
            role:
              "user",
            content:
              "Older follow-up",
          },
          {
            role:
              "assistant",
            content:
              "Older answer",
          },
          {
            role:
              "user",
            content:
              "Recent request one",
          },
          {
            role:
              "assistant",
            content:
              "Recent answer one",
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
              "Recent answer two",
          },
        ];

        const originalRecentMessages =
          messages
            .slice(
              -4,
            )
            .map(
              (
                message,
              ) => ({
                ...message,
              }),
            );

        let summarizerInput:
          readonly ChatMessage[] = [];

        const result =
          await compactConversation(
            messages,
            {
              reason:
                "manual",
              keepRecentMessages:
                4,
              hookRegistry:
                new HookRegistry(),
              summarize:
                async (
                  olderMessages,
                ) => {
                  summarizerInput =
                    olderMessages;

                  return "The user and Sky Code discussed an older file-reading task.";
                },
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
            10,
          afterMessageCount:
            5,
          droppedToolOutputCount:
            1,
          summary:
            "The user and Sky Code discussed an older file-reading task.",
        });

        expect(
          result
            .estimatedTokensBefore,
        ).toBeGreaterThan(
          0,
        );

        expect(
          summarizerInput,
        ).toHaveLength(
          6,
        );

        const summarizedToolResult =
          summarizerInput[3];

        expect(
          summarizedToolResult
            ?.content,
        ).toContain(
          "Stale tool output omitted",
        );

        expect(
          summarizedToolResult
            ?.content,
        ).not.toContain(
          "VERY LARGE STALE TOOL OUTPUT",
        );

        expect(
          messages[0],
        ).toEqual(
          createCompactionSummaryMessage(
            "The user and Sky Code discussed an older file-reading task.",
          ),
        );

        expect(
          messages.slice(
            1,
          ),
        ).toEqual(
          originalRecentMessages,
        );
      },
    );

    it(
      "fires PreCompact and PostCompact in order with shared metadata",
      async () => {
        const registry =
          new HookRegistry();

        const executionOrder:
          string[] = [];

        registry.register(
          "PreCompact",
          (
            event,
          ) => {
            executionOrder.push(
              "pre",
            );

            expect(
              event.messageCount,
            ).toBe(
              8,
            );

            expect(
              event.reason,
            ).toBe(
              "token-pressure",
            );

            expect(
              event.estimatedTokens,
            ).toBeGreaterThan(
              0,
            );

            event.metadata
              .verifiedByPreHook =
              true;
          },
          {
            source:
              "test-pre-hook",
          },
        );

        registry.register(
          "PostCompact",
          (
            event,
          ) => {
            executionOrder.push(
              "post",
            );

            expect(
              event.beforeMessageCount,
            ).toBe(
              8,
            );

            expect(
              event.afterMessageCount,
            ).toBe(
              3,
            );

            expect(
              event.summary,
            ).toBe(
              "Hook summary",
            );

            expect(
              event.metadata
                .verifiedByPreHook,
            ).toBe(
              true,
            );
          },
          {
            source:
              "test-post-hook",
          },
        );

        const messages =
          createMessages(
            8,
          );

        await compactConversation(
          messages,
          {
            reason:
              "token-pressure",
            keepRecentMessages:
              2,
            hookRegistry:
              registry,
            summarize:
              async () => {
                executionOrder.push(
                  "summarize",
                );

                return "Hook summary";
              },
          },
        );

        expect(
          executionOrder,
        ).toEqual([
          "pre",
          "summarize",
          "post",
        ]);
      },
    );

    it(
      "leaves short conversations unchanged without firing hooks or calling the summarizer",
      async () => {
        const messages =
          createMessages(
            7,
          );

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

        const preHook =
          vi.fn();

        const postHook =
          vi.fn();

        const summarizer =
          vi.fn(
            async () =>
              "Unused summary",
          );

        registry.register(
          "PreCompact",
          preHook,
        );

        registry.register(
          "PostCompact",
          postHook,
        );

        const result =
          await compactConversation(
            messages,
            {
              reason:
                "manual",
              hookRegistry:
                registry,
              summarize:
                summarizer,
            },
          );

        expect(
          result.compacted,
        ).toBe(
          false,
        );

        expect(
          result.beforeMessageCount,
        ).toBe(
          7,
        );

        expect(
          result.afterMessageCount,
        ).toBe(
          7,
        );

        expect(
          messages,
        ).toEqual(
          originalMessages,
        );

        expect(
          summarizer,
        ).not.toHaveBeenCalled();

        expect(
          preHook,
        ).not.toHaveBeenCalled();

        expect(
          postHook,
        ).not.toHaveBeenCalled();
      },
    );

    it(
      "preserves the original history when summarization fails",
      async () => {
        const messages =
          createMessages(
            10,
          );

        const originalMessages =
          messages.map(
            (
              message,
            ) => ({
              ...message,
            }),
          );

        await expect(
          compactConversation(
            messages,
            {
              reason:
                "manual",
              keepRecentMessages:
                4,
              hookRegistry:
                new HookRegistry(),
              summarize:
                async () => {
                  throw new Error(
                    "summary service failed",
                  );
                },
            },
          ),
        ).rejects.toThrow(
          "summary service failed",
        );

        expect(
          messages,
        ).toEqual(
          originalMessages,
        );
      },
    );

    it(
      "restores the original history when PostCompact fails",
      async () => {
        const messages =
          createMessages(
            10,
          );

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
              "post hook failed",
            );
          },
          {
            source:
              "failing-post-hook",
          },
        );

        await expect(
          compactConversation(
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
                  "Temporary summary",
            },
          ),
        ).rejects.toThrow(
          "Hook PostCompact from failing-post-hook failed: post hook failed",
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
