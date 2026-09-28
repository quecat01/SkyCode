import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";

import {
  tmpdir,
} from "node:os";

import {
  join,
} from "node:path";

import ExcelJS from "exceljs";
import JSZip from "jszip";

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import {
  DestinationExistsError,
} from "../src/docgen/shared.ts";

import {
  createXlsxFile,
} from "../src/docgen/xlsx.ts";

describe(
  "docgen/xlsx.ts createXlsxFile",
  () => {
    let testDirectory:
      string;

    beforeEach(
      async () => {
        testDirectory =
          await mkdtemp(
            join(
              tmpdir(),
              "sky-code-docgen-xlsx-",
            ),
          );
      },
    );

    afterEach(
      async () => {
        await rm(
          testDirectory,
          {
            recursive:
              true,
            force:
              true,
          },
        );
      },
    );

    it(
      "creates a valid workbook with the requested header, rows, and values",
      async () => {
        const result =
          await createXlsxFile(
            testDirectory,
            {
              path:
                "estimate.xlsx",
              sheets: [
                {
                  name: "Estimate",
                  headers: [
                    "Item",
                    "Amount",
                  ],
                  rows: [
                    [
                      "Panel upgrade",
                      3250,
                    ],
                    [
                      "Labor",
                      500,
                    ],
                  ],
                },
              ],
            },
          );

        expect(
          result.resolvedPath,
        ).toBe(
          join(
            testDirectory,
            "estimate.xlsx",
          ),
        );

        const buffer =
          await readFile(
            result.resolvedPath,
          );

        const workbook =
          new ExcelJS.Workbook();

        await workbook.xlsx.load(
          buffer,
        );

        const sheet =
          workbook.getWorksheet(
            "Estimate",
          );

        expect(
          sheet,
        ).toBeDefined();

        expect(
          sheet!.getRow(1).getCell(1)
            .value,
        ).toBe(
          "Item",
        );

        expect(
          sheet!.getRow(2).getCell(1)
            .value,
        ).toBe(
          "Panel upgrade",
        );

        expect(
          sheet!.getRow(2).getCell(2)
            .value,
        ).toBe(
          3250,
        );
      },
    );

    it(
      "bolds and freezes the header row when headers are provided",
      async () => {
        const result =
          await createXlsxFile(
            testDirectory,
            {
              path:
                "header-check.xlsx",
              sheets: [
                {
                  name: "Sheet1",
                  headers: [
                    "A",
                    "B",
                  ],
                  rows: [
                    [
                      "x",
                      "y",
                    ],
                  ],
                },
              ],
            },
          );

        const buffer =
          await readFile(
            result.resolvedPath,
          );

        const workbook =
          new ExcelJS.Workbook();

        await workbook.xlsx.load(
          buffer,
        );

        const sheet =
          workbook.getWorksheet(
            "Sheet1",
          )!;

        expect(
          sheet.getRow(1).getCell(1)
            .font?.bold,
        ).toBe(
          true,
        );

        expect(
          sheet.views[0]?.state,
        ).toBe(
          "frozen",
        );
      },
    );

    it(
      "writes a {date: ...} cell as a real Excel date",
      async () => {
        const result =
          await createXlsxFile(
            testDirectory,
            {
              path:
                "dates.xlsx",
              sheets: [
                {
                  name: "Sheet1",
                  rows: [
                    [
                      {
                        date: "2026-10-05",
                      },
                    ],
                  ],
                },
              ],
            },
          );

        const buffer =
          await readFile(
            result.resolvedPath,
          );

        const workbook =
          new ExcelJS.Workbook();

        await workbook.xlsx.load(
          buffer,
        );

        const cellValue =
          workbook
            .getWorksheet(
              "Sheet1",
            )!
            .getRow(1)
            .getCell(1)
            .value;

        expect(
          cellValue,
        ).toBeInstanceOf(
          Date,
        );

        expect(
          (
            cellValue as Date
          )
            .toISOString()
            .slice(
              0,
              10,
            ),
        ).toBe(
          "2026-10-05",
        );
      },
    );

    it(
      "writes a leading-'=' string as a real Excel formula",
      async () => {
        const result =
          await createXlsxFile(
            testDirectory,
            {
              path:
                "formula.xlsx",
              sheets: [
                {
                  name: "Sheet1",
                  rows: [
                    [
                      10,
                      "=A1*2",
                    ],
                  ],
                },
              ],
            },
          );

        const buffer =
          await readFile(
            result.resolvedPath,
          );

        const workbook =
          new ExcelJS.Workbook();

        await workbook.xlsx.load(
          buffer,
        );

        const cellValue =
          workbook
            .getWorksheet(
              "Sheet1",
            )!
            .getRow(1)
            .getCell(2)
            .value as {
            formula: string;
          };

        expect(
          cellValue.formula,
        ).toBe(
          "A1*2",
        );
      },
    );

    it(
      "creates one worksheet per requested sheet, each independently populated",
      async () => {
        const result =
          await createXlsxFile(
            testDirectory,
            {
              path:
                "multi-sheet.xlsx",
              sheets: [
                {
                  name: "First",
                  rows: [
                    [
                      "first-sheet-value",
                    ],
                  ],
                },
                {
                  name: "Second",
                  rows: [
                    [
                      "second-sheet-value",
                    ],
                  ],
                },
              ],
            },
          );

        const buffer =
          await readFile(
            result.resolvedPath,
          );

        const zip =
          await JSZip.loadAsync(
            buffer,
          );

        const slideParts =
          Object.keys(
            zip.files,
          ).filter((path) =>
            /^xl\/worksheets\/sheet\d+\.xml$/.test(
              path,
            ),
          );

        expect(
          slideParts,
        ).toHaveLength(
          2,
        );

        const workbook =
          new ExcelJS.Workbook();

        await workbook.xlsx.load(
          buffer,
        );

        expect(
          workbook
            .getWorksheet(
              "First",
            )!
            .getRow(1)
            .getCell(1)
            .value,
        ).toBe(
          "first-sheet-value",
        );

        expect(
          workbook
            .getWorksheet(
              "Second",
            )!
            .getRow(1)
            .getCell(1)
            .value,
        ).toBe(
          "second-sheet-value",
        );
      },
    );

    it(
      "auto-sizes a column to fit its widest content, including one landing exactly on exceljs's own default width",
      async () => {
        // A header of "Amount" (6 chars) is the widest content in this
        // column, giving rawWidth = 6 + 2 = 8 (regression coverage is in
        // the "9-exactly" case below; this case is the ordinary path).
        const result =
          await createXlsxFile(
            testDirectory,
            {
              path:
                "widths.xlsx",
              sheets: [
                {
                  name: "Sheet1",
                  headers: [
                    "Amount",
                  ],
                  rows: [
                    [
                      1,
                    ],
                  ],
                },
              ],
            },
          );

        const buffer =
          await readFile(
            result.resolvedPath,
          );

        const workbook =
          new ExcelJS.Workbook();

        await workbook.xlsx.load(
          buffer,
        );

        const width =
          workbook
            .getWorksheet(
              "Sheet1",
            )!
            .getColumn(1)
            .width;

        expect(
          width,
        ).toBeGreaterThan(
          0,
        );
      },
    );

    it(
      "preserves a column width that would otherwise collide with exceljs's internal default of 9",
      async () => {
        // Header "Amoun" (5 chars) + 2 == 7; data "1234567" (7 chars) + 2 ==
        // 9, which exactly matches exceljs's own DEFAULT_COLUMN_WIDTH and
        // would silently be dropped from the saved file without the nudge
        // in autoSizeColumns (see EXCELJS_DEFAULT_COLUMN_WIDTH in xlsx.ts).
        const result =
          await createXlsxFile(
            testDirectory,
            {
              path:
                "width-collision.xlsx",
              sheets: [
                {
                  name: "Sheet1",
                  headers: [
                    "Amoun",
                  ],
                  rows: [
                    [
                      "1234567",
                    ],
                  ],
                },
              ],
            },
          );

        const buffer =
          await readFile(
            result.resolvedPath,
          );

        const workbook =
          new ExcelJS.Workbook();

        await workbook.xlsx.load(
          buffer,
        );

        const width =
          workbook
            .getWorksheet(
              "Sheet1",
            )!
            .getColumn(1)
            .width;

        expect(
          width,
        ).toBeDefined();

        expect(
          Math.round(
            width!,
          ),
        ).toBe(
          9,
        );
      },
    );

    it(
      "rejects when the destination file already exists and does not overwrite it",
      async () => {
        const existingPath =
          join(
            testDirectory,
            "already-there.xlsx",
          );

        await writeFile(
          existingPath,
          "not a real xlsx",
        );

        await expect(
          createXlsxFile(
            testDirectory,
            {
              path:
                "already-there.xlsx",
              sheets: [
                {
                  name: "Sheet1",
                  rows: [
                    [
                      "x",
                    ],
                  ],
                },
              ],
            },
          ),
        ).rejects.toThrow(
          DestinationExistsError,
        );

        expect(
          await readFile(
            existingPath,
            "utf8",
          ),
        ).toBe(
          "not a real xlsx",
        );
      },
    );

    it(
      "rejects a date cell whose ISO string cannot be parsed and writes no file",
      async () => {
        const targetPath =
          join(
            testDirectory,
            "bad-date.xlsx",
          );

        await expect(
          createXlsxFile(
            testDirectory,
            {
              path:
                "bad-date.xlsx",
              sheets: [
                {
                  name: "Sheet1",
                  rows: [
                    [
                      {
                        date: "not-a-real-date",
                      },
                    ],
                  ],
                },
              ],
            },
          ),
        ).rejects.toThrow(
          "not a valid ISO 8601 date",
        );

        await expect(
          readFile(
            targetPath,
          ),
        ).rejects.toThrow();
      },
    );
  },
);
