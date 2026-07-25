import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type {
  ChatMessage,
} from "../src/chat.ts";

import {
  COMPACTION_SYSTEM_PROMPT,
  summarizeConversationWithModel,
} from "../src/compact-model.ts";

import type {
  AppConfig,
} from "../src/config.ts";

interface CapturedRequest {
  input:
    string;

  init?:
    RequestInit;
}

function createTestConfig():
  AppConfig {
  return {
    apiUrl:
      "http://litellm.test/v1",
    apiKey:
      "test-api-key",
  } as AppConfig;
}

afterEach(
  () => {
    vi.unstubAllGlobals();
  },
);

describe(
  "model-backed context summarization",
  () => {
    it(
      "requests a summary from the active LiteLLM model",
      async () => {
        const requests:
          CapturedRequest[] = [];

        const fetchMock =
          vi.fn(
            async (
              input:
                unknown,
              init?:
                RequestInit,
            ) => {
              requests.push({
                input:
                  String(
                    input,
                  ),
                init,
              });

              const responseBody = [
                'data: {"choices":[{"delta":{"content":"The earlier "}}]}',
                "",
                'data: {"choices":[{"delta":{"content":"conversation established the current task."}}]}',
                "",
                "data: [DONE]",
                "",
              ].join(
                "\n",
              );

              return new Response(
                responseBody,
                {
                  status:
                    200,
                  headers: {
                    "Content-Type":
                      "text/event-stream",
                  },
                },
              );
            },
          );

        vi.stubGlobal(
          "fetch",
          fetchMock,
        );

        const messages:
          ChatMessage[] = [
          {
            role:
              "user",
            content:
              "Please inspect the project.",
          },
          {
            role:
              "assistant",
            content:
              "The project inspection is complete.",
          },
        ];

        const summary =
          await summarizeConversationWithModel(
            createTestConfig(),
            "test-model",
            messages,
          );

        expect(
          summary,
        ).toBe(
          "The earlier conversation established the current task.",
        );

        expect(
          requests,
        ).toHaveLength(
          1,
        );

        expect(
          requests[0]?.input,
        ).toBe(
          "http://litellm.test/v1/chat/completions",
        );

        const requestBody =
          JSON.parse(
            String(
              requests[0]
                ?.init
                ?.body,
            ),
          );

        expect(
          requestBody,
        ).toEqual({
          model:
            "test-model",
          stream:
            true,
          messages: [
            {
              role:
                "system",
              content:
                COMPACTION_SYSTEM_PROMPT,
            },
            ...messages,
          ],
        });
      },
    );

    it(
      "does not modify the messages supplied to the summarizer",
      async () => {
        vi.stubGlobal(
          "fetch",
          vi.fn(
            async () =>
              new Response(
                [
                  'data: {"choices":[{"delta":{"content":"Summary"}}]}',
                  "",
                  "data: [DONE]",
                  "",
                ].join(
                  "\n",
                ),
                {
                  status:
                    200,
                  headers: {
                    "Content-Type":
                      "text/event-stream",
                  },
                },
              ),
          ),
        );

        const messages:
          ChatMessage[] = [
          {
            role:
              "user",
            content:
              "Original user message",
          },
          {
            role:
              "assistant",
            content:
              "Original assistant message",
          },
        ];

        const originalMessages =
          messages.map(
            (
              message,
            ) => ({
              ...message,
            }),
          );

        await summarizeConversationWithModel(
          createTestConfig(),
          "test-model",
          messages,
        );

        expect(
          messages,
        ).toEqual(
          originalMessages,
        );
      },
    );

    it(
      "rejects an empty model summary",
      async () => {
        vi.stubGlobal(
          "fetch",
          vi.fn(
            async () =>
              new Response(
                [
                  "data: [DONE]",
                  "",
                ].join(
                  "\n",
                ),
                {
                  status:
                    200,
                  headers: {
                    "Content-Type":
                      "text/event-stream",
                  },
                },
              ),
          ),
        );

        await expect(
          summarizeConversationWithModel(
            createTestConfig(),
            "test-model",
            [
              {
                role:
                  "user",
                content:
                  "Message to summarize",
              },
            ],
          ),
        ).rejects.toThrow(
          "Context compaction model returned an empty summary",
        );
      },
    );

    it(
      "rejects a blank active model without making a request",
      async () => {
        const fetchMock =
          vi.fn();

        vi.stubGlobal(
          "fetch",
          fetchMock,
        );

        await expect(
          summarizeConversationWithModel(
            createTestConfig(),
            "   ",
            [
              {
                role:
                  "user",
                content:
                  "Message to summarize",
              },
            ],
          ),
        ).rejects.toThrow(
          "Context compaction requires an active model",
        );

        expect(
          fetchMock,
        ).not.toHaveBeenCalled();
      },
    );
  },
);
