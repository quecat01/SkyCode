import {
  describe,
  expect,
  it,
} from "vitest";

import {
  NativeToolCallStreamAssembler,
} from "../src/native-tool-stream.ts";

/**
 * Builds one OpenAI-compatible streamed chunk carrying the given delta.
 */
function chunk(
  delta: Record<string, unknown>,
  finishReason: string | null = null,
): unknown {
  return {
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason,
      },
    ],
  };
}

/**
 * Builds one streamed tool-call fragment.
 */
function toolFragment(
  fragment: {
    index?: number;
    id?: string;
    name?: string;
    arguments?: string;
  },
): Record<string, unknown> {
  const fn: Record<string, unknown> = {};

  if (fragment.name !== undefined) {
    fn.name = fragment.name;
  }

  if (fragment.arguments !== undefined) {
    fn.arguments = fragment.arguments;
  }

  return {
    ...(fragment.index !== undefined
      ? { index: fragment.index }
      : {}),
    ...(fragment.id !== undefined
      ? { id: fragment.id, type: "function" }
      : {}),
    function: fn,
  };
}

/**
 * Feeds every chunk to a fresh assembler and finishes it.
 */
function assemble(
  chunks: unknown[],
  createId: () => string = () => "generated-id",
) {
  const assembler =
    new NativeToolCallStreamAssembler({
      createId,
    });

  for (const c of chunks) {
    assembler.push(c);
  }

  return assembler.finish();
}

describe(
  "native-tool-stream.ts NativeToolCallStreamAssembler",
  () => {
    it(
      "assembles a call whose JSON arguments arrive split across many fragments, preserving the call ID",
      () => {
        const result =
          assemble([
            chunk({
              role: "assistant",
              tool_calls: [
                toolFragment({
                  index: 0,
                  id: "call_abc123",
                  name: "create_docx",
                  arguments: "",
                }),
              ],
            }),
            chunk({
              tool_calls: [
                toolFragment({
                  index: 0,
                  arguments: '{"pa',
                }),
              ],
            }),
            chunk({
              tool_calls: [
                toolFragment({
                  index: 0,
                  arguments: 'th":"report.docx","con',
                }),
              ],
            }),
            chunk({
              tool_calls: [
                toolFragment({
                  index: 0,
                  arguments: 'tent":"# Report\\n\\nBody"}',
                }),
              ],
            }),
            chunk(
              {},
              "tool_calls",
            ),
          ]);

        expect(result.protocolIssues).toEqual([]);
        expect(result.protocolNotes).toEqual([]);
        expect(result.content).toBeNull();
        expect(result.finishReason).toBe("tool_calls");
        expect(result.toolCalls).toEqual([
          {
            id: "call_abc123",
            type: "function",
            function: {
              name: "create_docx",
              arguments:
                '{"path":"report.docx","content":"# Report\\n\\nBody"}',
            },
          },
        ]);

        expect(
          JSON.parse(
            result.toolCalls[0]!.function.arguments,
          ),
        ).toEqual({
          path: "report.docx",
          content: "# Report\n\nBody",
        });
      },
    );

    it(
      "assembles a function name that arrives in fragments",
      () => {
        const result =
          assemble([
            chunk({
              tool_calls: [
                toolFragment({
                  index: 0,
                  id: "call_1",
                  name: "create_",
                }),
              ],
            }),
            chunk({
              tool_calls: [
                toolFragment({
                  index: 0,
                  name: "xlsx",
                  arguments: '{"path":"a.xlsx","sheets":[]}',
                }),
              ],
            }),
          ]);

        expect(result.toolCalls[0]!.function.name).toBe(
          "create_xlsx",
        );
        expect(result.protocolIssues).toEqual([]);
      },
    );

    it(
      "does not double an ID or name that a provider repeats in full on every fragment",
      () => {
        const result =
          assemble([
            chunk({
              tool_calls: [
                toolFragment({
                  index: 0,
                  id: "call_1",
                  name: "create_pdf",
                  arguments: '{"path":',
                }),
              ],
            }),
            chunk({
              tool_calls: [
                toolFragment({
                  index: 0,
                  id: "call_1",
                  name: "create_pdf",
                  arguments: '"a.pdf","content":"x"}',
                }),
              ],
            }),
          ]);

        expect(result.toolCalls).toEqual([
          {
            id: "call_1",
            type: "function",
            function: {
              name: "create_pdf",
              arguments:
                '{"path":"a.pdf","content":"x"}',
            },
          },
        ]);
      },
    );

    it(
      "assembles an ID that arrives in fragments",
      () => {
        const result =
          assemble([
            chunk({
              tool_calls: [
                toolFragment({
                  index: 0,
                  id: "call_",
                  name: "read_file",
                }),
              ],
            }),
            chunk({
              tool_calls: [
                toolFragment({
                  index: 0,
                  id: "9f2",
                  arguments: '{"path":"a.txt"}',
                }),
              ],
            }),
          ]);

        expect(result.toolCalls[0]!.id).toBe(
          "call_9f2",
        );
      },
    );

    it(
      "keeps interleaved fragments of several calls apart by index and returns them in index order",
      () => {
        const result =
          assemble([
            chunk({
              tool_calls: [
                toolFragment({
                  index: 1,
                  id: "call_b",
                  name: "create_pdf",
                  arguments: '{"path":"b.pdf",',
                }),
                toolFragment({
                  index: 0,
                  id: "call_a",
                  name: "create_docx",
                  arguments: '{"path":"a.docx",',
                }),
              ],
            }),
            chunk({
              tool_calls: [
                toolFragment({
                  index: 0,
                  arguments: '"content":"A"}',
                }),
                toolFragment({
                  index: 1,
                  arguments: '"content":"B"}',
                }),
              ],
            }),
          ]);

        expect(
          result.toolCalls.map(
            (call) => [
              call.id,
              call.function.name,
              call.function.arguments,
            ],
          ),
        ).toEqual([
          [
            "call_a",
            "create_docx",
            '{"path":"a.docx","content":"A"}',
          ],
          [
            "call_b",
            "create_pdf",
            '{"path":"b.pdf","content":"B"}',
          ],
        ]);
      },
    );

    it(
      "matches fragments that carry no index to the most recent call",
      () => {
        const result =
          assemble([
            chunk({
              tool_calls: [
                toolFragment({
                  id: "call_x",
                  name: "read_file",
                  arguments: '{"pa',
                }),
              ],
            }),
            chunk({
              tool_calls: [
                toolFragment({
                  arguments: 'th":"x.txt"}',
                }),
              ],
            }),
          ]);

        expect(result.toolCalls).toHaveLength(1);
        expect(result.toolCalls[0]!.function.arguments).toBe(
          '{"path":"x.txt"}',
        );
      },
    );

    it(
      "assigns a local ID, reported as a non-fatal note, when the provider never sends one",
      () => {
        const result =
          assemble(
            [
              chunk({
                tool_calls: [
                  toolFragment({
                    index: 0,
                    name: "read_file",
                    arguments: '{"path":"a.txt"}',
                  }),
                ],
              }),
            ],
            () => "sky_call_fixed",
          );

        expect(result.toolCalls[0]!.id).toBe(
          "sky_call_fixed",
        );
        expect(result.protocolIssues).toEqual([]);
        expect(result.protocolNotes).toHaveLength(1);
        expect(result.protocolNotes[0]).toContain(
          "without a call ID",
        );
      },
    );

    it(
      "reports a call that never received a function name as a fatal protocol issue and omits it",
      () => {
        const result =
          assemble([
            chunk({
              tool_calls: [
                toolFragment({
                  index: 0,
                  id: "call_1",
                  arguments: '{"path":"a.txt"}',
                }),
              ],
            }),
          ]);

        expect(result.toolCalls).toEqual([]);
        expect(result.protocolIssues).toHaveLength(1);
        expect(result.protocolIssues[0]).toContain(
          "never received a function name",
        );
      },
    );

    it(
      "reports a stream cut off by the token limit mid-call as incomplete",
      () => {
        const result =
          assemble([
            chunk({
              tool_calls: [
                toolFragment({
                  index: 0,
                  id: "call_1",
                  name: "create_docx",
                  arguments: '{"path":"a.docx","content":"trunc',
                }),
              ],
            }),
            chunk(
              {},
              "length",
            ),
          ]);

        expect(result.protocolIssues.join(" ")).toContain(
          "cut off by the output token limit",
        );
      },
    );

    it(
      "never parses or repairs arguments itself: malformed JSON is assembled verbatim for the strategy to reject",
      () => {
        const result =
          assemble([
            chunk({
              tool_calls: [
                toolFragment({
                  index: 0,
                  id: "call_1",
                  name: "create_docx",
                  arguments: '{"path": "a.docx",',
                }),
              ],
            }),
          ]);

        expect(result.protocolIssues).toEqual([]);
        expect(result.toolCalls[0]!.function.arguments).toBe(
          '{"path": "a.docx",',
        );
      },
    );

    it(
      'normalizes an empty arguments string (a no-argument call) to "{}"',
      () => {
        const result =
          assemble([
            chunk({
              tool_calls: [
                toolFragment({
                  index: 0,
                  id: "call_1",
                  name: "some_tool",
                  arguments: "",
                }),
              ],
            }),
          ]);

        expect(result.toolCalls[0]!.function.arguments).toBe(
          "{}",
        );
      },
    );

    it(
      "accumulates plain text content and ignores malformed or unrelated chunks",
      () => {
        const result =
          assemble([
            "not an object",
            {
              choices: [],
            },
            {
              choices: [
                {
                  delta: null,
                },
              ],
            },
            chunk({
              content: "All four ",
            }),
            chunk({
              content: "files were created.",
            }),
            chunk(
              {},
              "stop",
            ),
          ]);

        expect(result.content).toBe(
          "All four files were created.",
        );
        expect(result.toolCalls).toEqual([]);
        expect(result.protocolIssues).toEqual([]);
      },
    );
  },
);
