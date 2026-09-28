import {
  describe,
  expect,
  it,
} from "vitest";

import {
  parseSkyToolRequest,
  type SkyToolRequest,
} from "../src/tools.ts";

/**
 * Wraps a tool call as a complete fenced sky-tool block, matching the
 * protocol format parseSkyToolRequest expects (see tests/basic.test.ts for
 * the same convention used elsewhere in this project).
 */
function toolBlock(
  tool: string,
  args: unknown,
): string {
  return [
    "```sky-tool",
    JSON.stringify({
      tool,
      args,
    }),
    "```",
  ].join(
    "\n",
  );
}

describe(
  "tools.ts schema validation for the document-generation tools",
  () => {
    describe(
      "create_docx / create_pdf",
      () => {
        it.each([
          "create_docx",
          "create_pdf",
        ])(
          "parses a valid %s request",
          (tool) => {
            const request =
              parseSkyToolRequest(
                toolBlock(
                  tool,
                  {
                    path: "report.docx",
                    content:
                      "# Title\n\nBody.",
                  },
                ),
              ) as SkyToolRequest;

            expect(
              request.tool,
            ).toBe(
              tool,
            );

            expect(
              (
                request.args as {
                  path: string;
                }
              ).path,
            ).toBe(
              "report.docx",
            );
          },
        );

        it.each([
          "create_docx",
          "create_pdf",
        ])(
          "rejects %s when path is missing",
          (tool) => {
            expect(
              () =>
                parseSkyToolRequest(
                  toolBlock(
                    tool,
                    {
                      content:
                        "body only",
                    },
                  ),
                ),
            ).toThrow(
              'Tool argument "path" must be a string',
            );
          },
        );

        it.each([
          "create_docx",
          "create_pdf",
        ])(
          "rejects %s when content is missing",
          (tool) => {
            expect(
              () =>
                parseSkyToolRequest(
                  toolBlock(
                    tool,
                    {
                      path: "report.docx",
                    },
                  ),
                ),
            ).toThrow(
              'Tool argument "content" must be a string',
            );
          },
        );

        it.each([
          "create_docx",
          "create_pdf",
        ])(
          "rejects %s when path is the wrong type",
          (tool) => {
            expect(
              () =>
                parseSkyToolRequest(
                  toolBlock(
                    tool,
                    {
                      path: 12345,
                      content:
                        "body",
                    },
                  ),
                ),
            ).toThrow(
              'Tool argument "path" must be a string',
            );
          },
        );
      },
    );

    describe(
      "create_xlsx",
      () => {
        it(
          "parses a valid request",
          () => {
            const request =
              parseSkyToolRequest(
                toolBlock(
                  "create_xlsx",
                  {
                    path: "book.xlsx",
                    sheets: [
                      {
                        name: "Sheet1",
                        rows: [
                          [
                            "a",
                            1,
                          ],
                        ],
                      },
                    ],
                  },
                ),
              );

            expect(
              request?.tool,
            ).toBe(
              "create_xlsx",
            );
          },
        );

        it(
          "rejects a request missing sheets entirely",
          () => {
            expect(
              () =>
                parseSkyToolRequest(
                  toolBlock(
                    "create_xlsx",
                    {
                      path: "book.xlsx",
                    },
                  ),
                ),
            ).toThrow(
              'Tool argument "sheets" must be a non-empty array',
            );
          },
        );

        it(
          "rejects an empty sheets array",
          () => {
            expect(
              () =>
                parseSkyToolRequest(
                  toolBlock(
                    "create_xlsx",
                    {
                      path: "book.xlsx",
                      sheets: [],
                    },
                  ),
                ),
            ).toThrow(
              'Tool argument "sheets" must be a non-empty array',
            );
          },
        );

        it(
          "rejects a sheet missing a name",
          () => {
            expect(
              () =>
                parseSkyToolRequest(
                  toolBlock(
                    "create_xlsx",
                    {
                      path: "book.xlsx",
                      sheets: [
                        {
                          rows: [
                            [
                              "a",
                            ],
                          ],
                        },
                      ],
                    },
                  ),
                ),
            ).toThrow();
          },
        );

        it(
          "rejects a cell value of an unsupported type (object other than {date})",
          () => {
            expect(
              () =>
                parseSkyToolRequest(
                  toolBlock(
                    "create_xlsx",
                    {
                      path: "book.xlsx",
                      sheets: [
                        {
                          name: "Sheet1",
                          rows: [
                            [
                              {
                                unsupported:
                                  true,
                              },
                            ],
                          ],
                        },
                      ],
                    },
                  ),
                ),
            ).toThrow(
              'must be a string, number, boolean, or {"date":"YYYY-MM-DD"}',
            );
          },
        );

        it(
          "rejects rows that are not arrays",
          () => {
            expect(
              () =>
                parseSkyToolRequest(
                  toolBlock(
                    "create_xlsx",
                    {
                      path: "book.xlsx",
                      sheets: [
                        {
                          name: "Sheet1",
                          rows: "not-an-array",
                        },
                      ],
                    },
                  ),
                ),
            ).toThrow();
          },
        );
      },
    );

    describe(
      "create_pptx",
      () => {
        it(
          "parses a valid request with one slide of each type",
          () => {
            const request =
              parseSkyToolRequest(
                toolBlock(
                  "create_pptx",
                  {
                    path: "deck.pptx",
                    slides: [
                      {
                        type: "title",
                        title:
                          "Deck Title",
                      },
                      {
                        type: "content",
                        bullets: [
                          "one",
                        ],
                      },
                      {
                        type: "chart",
                        categories: [
                          "A",
                          "B",
                        ],
                        series: [
                          {
                            name: "S1",
                            values: [
                              1,
                              2,
                            ],
                          },
                        ],
                      },
                    ],
                  },
                ),
              );

            expect(
              request?.tool,
            ).toBe(
              "create_pptx",
            );
          },
        );

        it(
          "rejects a request missing slides entirely",
          () => {
            expect(
              () =>
                parseSkyToolRequest(
                  toolBlock(
                    "create_pptx",
                    {
                      path: "deck.pptx",
                    },
                  ),
                ),
            ).toThrow(
              'Tool argument "slides" must be a non-empty array',
            );
          },
        );

        it(
          "rejects an empty slides array",
          () => {
            expect(
              () =>
                parseSkyToolRequest(
                  toolBlock(
                    "create_pptx",
                    {
                      path: "deck.pptx",
                      slides: [],
                    },
                  ),
                ),
            ).toThrow(
              'Tool argument "slides" must be a non-empty array',
            );
          },
        );

        it(
          "rejects a slide with an unrecognized type",
          () => {
            expect(
              () =>
                parseSkyToolRequest(
                  toolBlock(
                    "create_pptx",
                    {
                      path: "deck.pptx",
                      slides: [
                        {
                          type: "video",
                        },
                      ],
                    },
                  ),
                ),
            ).toThrow(
              'slides[0].type must be "title", "content", or "chart"',
            );
          },
        );

        it(
          "rejects a title slide missing its required title",
          () => {
            expect(
              () =>
                parseSkyToolRequest(
                  toolBlock(
                    "create_pptx",
                    {
                      path: "deck.pptx",
                      slides: [
                        {
                          type: "title",
                        },
                      ],
                    },
                  ),
                ),
            ).toThrow(
              'Tool argument "title" must be a string',
            );
          },
        );

        it(
          "rejects a chart slide missing categories",
          () => {
            expect(
              () =>
                parseSkyToolRequest(
                  toolBlock(
                    "create_pptx",
                    {
                      path: "deck.pptx",
                      slides: [
                        {
                          type: "chart",
                          series: [
                            {
                              name: "S1",
                              values: [
                                1,
                              ],
                            },
                          ],
                        },
                      ],
                    },
                  ),
                ),
            ).toThrow();
          },
        );

        it(
          "rejects a chart slide whose series values are not all numbers",
          () => {
            expect(
              () =>
                parseSkyToolRequest(
                  toolBlock(
                    "create_pptx",
                    {
                      path: "deck.pptx",
                      slides: [
                        {
                          type: "chart",
                          categories: [
                            "A",
                          ],
                          series: [
                            {
                              name: "S1",
                              values: [
                                "not-a-number",
                              ],
                            },
                          ],
                        },
                      ],
                    },
                  ),
                ),
            ).toThrow(
              "values must be an array of numbers",
            );
          },
        );

        it(
          "rejects a chart slide with an empty series array",
          () => {
            expect(
              () =>
                parseSkyToolRequest(
                  toolBlock(
                    "create_pptx",
                    {
                      path: "deck.pptx",
                      slides: [
                        {
                          type: "chart",
                          categories: [
                            "A",
                          ],
                          series: [],
                        },
                      ],
                    },
                  ),
                ),
            ).toThrow(
              "series must be a non-empty array",
            );
          },
        );

        it(
          "rejects a content slide's table when rows are the wrong shape",
          () => {
            expect(
              () =>
                parseSkyToolRequest(
                  toolBlock(
                    "create_pptx",
                    {
                      path: "deck.pptx",
                      slides: [
                        {
                          type: "content",
                          table: {
                            headers: [
                              "A",
                            ],
                            rows: [
                              "not-a-row-array",
                            ],
                          },
                        },
                      ],
                    },
                  ),
                ),
            ).toThrow();
          },
        );

        it(
          "rejects a content slide's image when path is missing",
          () => {
            expect(
              () =>
                parseSkyToolRequest(
                  toolBlock(
                    "create_pptx",
                    {
                      path: "deck.pptx",
                      slides: [
                        {
                          type: "content",
                          image: {
                            caption:
                              "no path here",
                          },
                        },
                      ],
                    },
                  ),
                ),
            ).toThrow(
              'Tool argument "path" must be a string',
            );
          },
        );

        it(
          "rejects a slide that is not a JSON object",
          () => {
            expect(
              () =>
                parseSkyToolRequest(
                  toolBlock(
                    "create_pptx",
                    {
                      path: "deck.pptx",
                      slides: [
                        "not-an-object",
                      ],
                    },
                  ),
                ),
            ).toThrow(
              "slides[0] must be a JSON object",
            );
          },
        );
      },
    );
  },
);
