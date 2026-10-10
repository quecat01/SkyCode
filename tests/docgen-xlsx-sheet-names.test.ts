import {
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";

import {
  tmpdir,
} from "node:os";

import {
  join,
} from "node:path";

import ExcelJS from "exceljs";

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import {
  findWorksheetNameProblem,
  resolveWorksheetNames,
} from "../src/docgen/worksheet-names.ts";

import {
  createXlsxFile,
} from "../src/docgen/xlsx.ts";

import {
  createPhase1ToolHandlers,
} from "../src/toolhandlers.ts";

import {
  validateSkyToolRequest,
  type CreateXlsxArgs,
  type XlsxSheetInput,
} from "../src/tools.ts";

import {
  BUILTIN_TOOL_DEFINITIONS,
} from "../src/agent/tool-schema.ts";

import {
  NativeStrategy,
} from "../src/agent/strategies/native.ts";

/**
 * Tests for optional create_xlsx worksheet names: the public schema, argument
 * validation (Excel's naming rules for explicit names), deterministic default
 * names, and the real generated workbook, including that numeric budget
 * cells stay numbers.
 */

/** Validates create_xlsx arguments exactly as every strategy does. */
function validateXlsx(
  args: unknown,
): CreateXlsxArgs {
  return validateSkyToolRequest(
    "create_xlsx",
    args,
  ).args as CreateXlsxArgs;
}

/** One small sheet, with an optional name. */
function sheet(
  name?: string,
): Record<string, unknown> {
  return {
    ...(name !== undefined
      ? {
          name,
        }
      : {}),
    rows: [
      [
        "a",
      ],
    ],
  };
}

describe(
  "create_xlsx schema",
  () => {
    it(
      "lists only rows as required for a sheet, with name optional and bounded",
      () => {
        const definition =
          BUILTIN_TOOL_DEFINITIONS.find(
            (tool) =>
              tool.name === "create_xlsx",
          )!;

        const sheetSchema =
          (
            definition.parameters
              .properties as Record<
              string,
              {
                items: {
                  required: string[];
                  properties: Record<
                    string,
                    Record<string, unknown>
                  >;
                };
              }
            >
          ).sheets!.items;

        expect(
          sheetSchema.required,
        ).toEqual([
          "rows",
        ]);
        expect(
          sheetSchema.properties.name,
        ).toMatchObject({
          type: "string",
          minLength: 1,
          maxLength: 31,
        });
      },
    );
  },
);

describe(
  "create_xlsx without sheet names on the native path",
  () => {
    it(
      "returns an executable tool call, not a rejected one",
      async () => {
        const args = {
          path: "budget.xlsx",
          sheets: [
            {
              headers: [
                "Item",
                "Cost",
              ],
              rows: [
                [
                  "Panel upgrade",
                  2500,
                ],
              ],
            },
          ],
        };

        const action =
          await new NativeStrategy(
            {
              async complete() {
                return {
                  content: null,
                  toolCalls: [
                    {
                      id: "x1",
                      name: "create_xlsx",
                      argumentsJson:
                        JSON.stringify(args),
                    },
                  ],
                };
              },
            },
            "system prompt",
          ).getNextAction(
            {
              priorTurns: [],
              goal: "Create a budget workbook.",
              history: [],
            },
            [
              ...BUILTIN_TOOL_DEFINITIONS,
            ],
            "m",
          );

        expect(action).toEqual({
          kind: "tool_call",
          tool: "create_xlsx",
          callId: "x1",
          arguments: args,
        });
      },
    );
  },
);

describe(
  "create_xlsx sheet name validation",
  () => {
    it(
      "accepts omitted names and keeps explicit valid names exactly",
      () => {
        const args =
          validateXlsx({
            path: "book.xlsx",
            sheets: [
              sheet(),
              sheet(
                " Q3 Budget (draft) ",
              ),
            ],
          });

        expect(
          args.sheets.map(
            (one) =>
              one.name,
          ),
        ).toEqual([
          undefined,
          " Q3 Budget (draft) ",
        ]);
        expect(
          "name" in args.sheets[0]!,
        ).toBe(false);
      },
    );

    it.each([
      [
        "A".repeat(32),
        "must be at most 31 characters (it has 32)",
      ],
      [
        "Q3/Q4",
        "cannot contain any of these characters",
      ],
      [
        "Totals [final]",
        "cannot contain any of these characters",
      ],
      [
        "'Budget",
        "cannot start or end with an apostrophe",
      ],
      [
        "history",
        'cannot be "History"',
      ],
    ])(
      "rejects the explicit name %j, naming the field and the default",
      (name, problem) => {
        expect(
          () =>
            validateXlsx({
              path: "book.xlsx",
              sheets: [
                sheet(
                  "Summary",
                ),
                sheet(
                  name,
                ),
              ],
            }),
        ).toThrow(
          `Tool argument "sheets[1].name" ${problem}`,
        );

        expect(
          () =>
            validateXlsx({
              path: "book.xlsx",
              sheets: [
                sheet(
                  "Summary",
                ),
                sheet(
                  name,
                ),
              ],
            }),
        ).toThrow(
          "Omit it to use the default name Sheet2",
        );
      },
    );

    it(
      "accepts a name of exactly 31 characters",
      () => {
        expect(
          validateXlsx({
            path: "book.xlsx",
            sheets: [
              sheet(
                "B".repeat(31),
              ),
            ],
          }).sheets[0]!.name,
        ).toBe(
          "B".repeat(31),
        );
      },
    );

    it(
      "rejects explicit names that repeat another sheet's name, ignoring case",
      () => {
        expect(
          () =>
            validateXlsx({
              path: "book.xlsx",
              sheets: [
                sheet(
                  "Budget",
                ),
                sheet(),
                sheet(
                  "BUDGET",
                ),
              ],
            }),
        ).toThrow(
          'Tool argument "sheets[2].name" repeats the name of sheets[0]',
        );
      },
    );

    it.each([
      [
        null,
        "must be a string",
      ],
      [
        42,
        "must be a string",
      ],
      [
        "",
        "must not be empty",
      ],
      [
        "   ",
        "must not be empty",
      ],
    ])(
      "still rejects a present but invalid name (%j)",
      (name, problem) => {
        expect(
          () =>
            validateXlsx({
              path: "book.xlsx",
              sheets: [
                {
                  name,
                  rows: [],
                },
              ],
            }),
        ).toThrow(
          `Tool argument "sheets[0].name" ${problem}`,
        );
      },
    );

    it(
      "still rejects genuinely invalid sheet data, unrelated to names",
      () => {
        expect(
          () =>
            validateXlsx({
              path: "book.xlsx",
              sheets: [
                {
                  rows: "not rows",
                },
              ],
            }),
        ).toThrow(
          "sheets[0].rows must be an array",
        );

        expect(
          () =>
            validateXlsx({
              path: "book.xlsx",
              sheets: [
                {
                  headers: "Item",
                  rows: [],
                },
              ],
            }),
        ).toThrow(
          'Tool argument "sheets[0].headers" must be an array of strings',
        );
      },
    );
  },
);

describe(
  "resolveWorksheetNames",
  () => {
    it(
      "names unnamed sheets Sheet1, Sheet2, ... by position",
      () => {
        expect(
          resolveWorksheetNames([
            {},
            {},
            {},
          ]),
        ).toEqual([
          "Sheet1",
          "Sheet2",
          "Sheet3",
        ]);
      },
    );

    it(
      "keeps explicit names and gives each unnamed sheet its positional default",
      () => {
        expect(
          resolveWorksheetNames([
            {
              name: "Budget",
            },
            {},
            {
              name: "Notes",
            },
            {},
          ]),
        ).toEqual([
          "Budget",
          "Sheet2",
          "Notes",
          "Sheet4",
        ]);
      },
    );

    it(
      "moves a default to the next unused SheetN when an explicit name (any case) already uses it, even on a later sheet",
      () => {
        expect(
          resolveWorksheetNames([
            {},
            {
              name: "sheet1",
            },
            {},
            {
              name: "Sheet4",
            },
          ]),
        ).toEqual([
          "Sheet2",
          "sheet1",
          "Sheet3",
          "Sheet4",
        ]);

        expect(
          resolveWorksheetNames([
            {},
            {},
            {
              name: "Sheet2",
            },
          ]),
        ).toEqual([
          "Sheet1",
          "Sheet3",
          "Sheet2",
        ]);
      },
    );

    it(
      "skips every taken SheetN, including defaults it already assigned",
      () => {
        // Sheet1 and Sheet2 are both explicit, so the first sheet skips two.
        expect(
          resolveWorksheetNames([
            {},
            {
              name: "Sheet1",
            },
            {
              name: "Sheet2",
            },
          ]),
        ).toEqual([
          "Sheet3",
          "Sheet1",
          "Sheet2",
        ]);

        // The first sheet's default moves to Sheet2, so the second sheet's
        // own positional default (Sheet2) is already taken by it.
        expect(
          resolveWorksheetNames([
            {},
            {},
            {
              name: "Sheet1",
            },
          ]),
        ).toEqual([
          "Sheet2",
          "Sheet3",
          "Sheet1",
        ]);
      },
    );

    it(
      "always returns valid, case-insensitively unique names",
      () => {
        const sheets: {
          name?: string;
        }[] = [
          {},
          {
            name: "SHEET2",
          },
          {},
          {
            name: "sheet3",
          },
          {},
          {},
        ];

        const names =
          resolveWorksheetNames(
            sheets,
          );

        expect(
          new Set(
            names.map(
              (name) =>
                name.toLowerCase(),
            ),
          ).size,
        ).toBe(
          sheets.length,
        );

        for (
          const name of names
        ) {
          expect(
            findWorksheetNameProblem(
              name,
            ),
          ).toBeUndefined();
        }
      },
    );
  },
);

describe(
  "generated workbooks with optional sheet names",
  () => {
    let testDirectory: string;

    beforeEach(
      async () => {
        testDirectory =
          await mkdtemp(
            join(
              tmpdir(),
              "sky-code-xlsx-names-",
            ),
          );
      },
    );

    afterEach(
      async () => {
        await rm(
          testDirectory,
          {
            recursive: true,
            force: true,
          },
        );
      },
    );

    /** Builds a workbook through validation, then loads it back. */
    async function buildAndLoad(
      sheets: unknown[],
    ): Promise<ExcelJS.Workbook> {
      const result =
        await createXlsxFile(
          testDirectory,
          validateXlsx({
            path: "book.xlsx",
            sheets,
          }),
        );

      const workbook =
        new ExcelJS.Workbook();

      await workbook.xlsx.load(
        await readFile(
          result.resolvedPath,
        ),
      );

      return workbook;
    }

    it(
      "names a single unnamed sheet Sheet1",
      async () => {
        const workbook =
          await buildAndLoad([
            sheet(),
          ]);

        expect(
          workbook.worksheets.map(
            (one) =>
              one.name,
          ),
        ).toEqual([
          "Sheet1",
        ]);
      },
    );

    it(
      "names multiple unnamed sheets in order",
      async () => {
        const workbook =
          await buildAndLoad([
            sheet(),
            sheet(),
            sheet(),
          ]);

        expect(
          workbook.worksheets.map(
            (one) =>
              one.name,
          ),
        ).toEqual([
          "Sheet1",
          "Sheet2",
          "Sheet3",
        ]);
      },
    );

    it(
      "mixes named and unnamed sheets without a collision",
      async () => {
        const workbook =
          await buildAndLoad([
            sheet(),
            sheet(
              "Sheet1",
            ),
            sheet(
              "Budget",
            ),
            sheet(),
          ]);

        expect(
          workbook.worksheets.map(
            (one) =>
              one.name,
          ),
        ).toEqual([
          "Sheet2",
          "Sheet1",
          "Budget",
          "Sheet4",
        ]);
      },
    );

    it(
      "keeps numeric budget cells as numbers in an unnamed sheet",
      async () => {
        const workbook =
          await buildAndLoad([
            {
              headers: [
                "Item",
                "Cost",
              ],
              rows: [
                [
                  "Panel upgrade",
                  2500,
                ],
                [
                  "Permit",
                  750.5,
                ],
                [
                  "Total",
                  "=SUM(B2:B3)",
                ],
              ],
            },
          ]);

        const budget =
          workbook.getWorksheet(
            "Sheet1",
          )!;

        expect(
          budget.getCell(
            "B2",
          ).value,
        ).toBe(2500);
        expect(
          budget.getCell(
            "B2",
          ).type,
        ).toBe(
          ExcelJS.ValueType.Number,
        );
        expect(
          budget.getCell(
            "B3",
          ).value,
        ).toBe(750.5);
        expect(
          budget.getCell(
            "B3",
          ).type,
        ).toBe(
          ExcelJS.ValueType.Number,
        );
        expect(
          budget.getCell(
            "B4",
          ).type,
        ).toBe(
          ExcelJS.ValueType.Formula,
        );
      },
    );

    it(
      "reports the final worksheet names in the tool's success output",
      async () => {
        const handlers =
          createPhase1ToolHandlers(
            testDirectory,
            {
              getMode: () =>
                "default",
              approvalPrompt:
                async () => true,
            },
          );

        const sheets: XlsxSheetInput[] = [
          {
            name: "Budget",
            rows: [
              [
                1,
              ],
            ],
          },
          {
            rows: [
              [
                2,
              ],
            ],
          },
        ];

        const result =
          await handlers.create_xlsx({
            path: "report.xlsx",
            sheets,
          });

        expect(result.success).toBe(true);
        expect(result.output).toContain(
          "Worksheets: Budget, Sheet2.",
        );
      },
    );
  },
);
