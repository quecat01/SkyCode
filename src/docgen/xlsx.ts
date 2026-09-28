/**
 * XLSX generation for Sky Code's create_xlsx tool.
 *
 * Builds a real Excel workbook from the model's sheet/row data using the
 * `exceljs` package and writes it through the shared document-generation
 * utility (shared.ts). Every use of `exceljs` is confined to this file, in
 * line with the project's general practice of isolating a single external
 * library's API surface to one file per document format.
 *
 * Header styling (bold, frozen), column auto-sizing, and alternating
 * row banding with thin borders are fixed defaults applied to every sheet
 * rather than model-facing options (see the create_xlsx tool schema in
 * tools.ts), keeping the schema itself to just a destination path and plain
 * sheet/row data.
 */

import ExcelJS from "exceljs";

import {
  createDocumentFile,
  type CreateDocumentFileResult,
} from "./shared.js";

import type {
  CreateXlsxArgs,
  XlsxCellValue,
  XlsxSheetInput,
} from "../tools.js";

/** Fill color for the header row (light gray), fixed for every sheet. */
const HEADER_FILL_ARGB = "FFD9D9D9";

/** Fill color for banded (odd-indexed) data rows, fixed for every sheet. */
const BAND_FILL_ARGB = "FFF2F2F2";

/** Thin gray border applied to every cell, fixed for every sheet. */
const CELL_BORDER: Partial<ExcelJS.Border> = {
  style: "thin",
  color: {
    argb: "FFBFBFBF",
  },
};

/** Smallest column width, in Excel's character-width units, ever assigned. */
const MIN_COLUMN_WIDTH = 8;

/** Largest column width auto-sizing will assign before capping. */
const MAX_COLUMN_WIDTH = 60;

/**
 * exceljs's own built-in default column width (see DEFAULT_COLUMN_WIDTH in
 * its Column class). exceljs treats a column whose width exactly equals this
 * value as "not customized" and silently omits it from the saved file's
 * `<cols>` list, discarding the assignment entirely rather than writing it.
 * autoSizeColumns() below nudges any computed width that happens to land
 * exactly on this value so a real, explicit width is never lost to that
 * behavior.
 */
const EXCELJS_DEFAULT_COLUMN_WIDTH = 9;

/**
 * True when a cell value is the {date: string} shape rather than a plain
 * string, number, or boolean.
 *
 * @param {XlsxCellValue} value - Cell value from a validated sheet input.
 * @returns {boolean} True if value is a date cell.
 */
function isDateCellValue(
  value: XlsxCellValue,
): value is { date: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "date" in value
  );
}

/**
 * True when a cell value is a string that should be written as an Excel
 * formula: a leading "=" is the model's signal that the rest of the string
 * is a formula rather than literal text, matching common spreadsheet
 * convention.
 *
 * @param {XlsxCellValue} value - Cell value from a validated sheet input.
 * @returns {boolean} True if value is a formula string.
 */
function isFormulaCellValue(
  value: XlsxCellValue,
): value is string {
  return (
    typeof value === "string" &&
    value.startsWith("=") &&
    value.length > 1
  );
}

/**
 * Converts one validated XlsxCellValue into the shape exceljs expects for a
 * cell's `value` assignment.
 *
 * @param {XlsxCellValue} value - Cell value from a validated sheet input.
 * @returns {ExcelJS.CellValue} Equivalent exceljs cell value.
 * @throws {Error} If a date cell's ISO string cannot be parsed.
 */
function toExcelCellValue(
  value: XlsxCellValue,
): ExcelJS.CellValue {
  if (isDateCellValue(value)) {
    const parsed = new Date(
      value.date,
    );

    if (Number.isNaN(parsed.getTime())) {
      throw new Error(
        `"${value.date}" is not a valid ISO 8601 date.`,
      );
    }

    return parsed;
  }

  if (isFormulaCellValue(value)) {
    return {
      formula: value.slice(1),
    };
  }

  return value;
}

/**
 * Renders one cell value as plain text for the purpose of estimating a
 * column's display width. Only used for auto-sizing, never written to the
 * workbook itself.
 *
 * @param {XlsxCellValue} value - Cell value from a validated sheet input.
 * @returns {string} Plain-text approximation of the cell's displayed width.
 */
function cellValueDisplayLength(
  value: XlsxCellValue,
): number {
  if (isDateCellValue(value)) {
    // Dates render as a fixed-format date string (see applyDateFormat
    // below); "2026-09-27" is a representative width for any valid date.
    return 10;
  }

  return String(value).length;
}

/**
 * Applies the fixed header-row and data-row styling described at the top of
 * this file to one worksheet already populated with rows.
 *
 * @param {ExcelJS.Worksheet} worksheet - Worksheet to style, with its header
 * row (if any) and data rows already added.
 * @param {boolean} hasHeader - True when row 1 is a header row and should be
 * styled and frozen rather than treated as the first data row.
 * @returns {void}
 * @throws {Error} None; only mutates cell/row style properties.
 *
 * Side effects: mutates cell styles and worksheet.views on the worksheet.
 */
function styleWorksheet(
  worksheet: ExcelJS.Worksheet,
  hasHeader: boolean,
): void {
  if (hasHeader) {
    worksheet.views = [
      {
        state: "frozen",
        ySplit: 1,
      },
    ];

    const headerRow = worksheet.getRow(1);

    headerRow.eachCell(
      {
        includeEmpty: true,
      },
      (cell) => {
        cell.font = {
          bold: true,
        };
        cell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: {
            argb: HEADER_FILL_ARGB,
          },
        };
        cell.border = {
          top: CELL_BORDER,
          left: CELL_BORDER,
          bottom: CELL_BORDER,
          right: CELL_BORDER,
        };
      },
    );
  }

  const firstDataRowNumber = hasHeader ? 2 : 1;

  for (
    let rowNumber = firstDataRowNumber;
    rowNumber <= worksheet.rowCount;
    rowNumber++
  ) {
    const row = worksheet.getRow(
      rowNumber,
    );

    // Banding alternates starting from the first data row regardless of
    // whether a header row precedes it, so the stripe pattern reads
    // consistently no matter which sheets in the workbook have headers.
    const isBandedRow =
      (rowNumber - firstDataRowNumber) % 2 === 1;

    row.eachCell(
      {
        includeEmpty: true,
      },
      (cell) => {
        if (isBandedRow) {
          cell.fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: {
              argb: BAND_FILL_ARGB,
            },
          };
        }

        cell.border = {
          top: CELL_BORDER,
          left: CELL_BORDER,
          bottom: CELL_BORDER,
          right: CELL_BORDER,
        };
      },
    );
  }
}

/**
 * Sets a date number format on every date-valued cell in a worksheet's data
 * rows, so dates display as dates rather than raw serial numbers.
 *
 * @param {ExcelJS.Worksheet} worksheet - Worksheet already populated with
 * rows.
 * @param {XlsxSheetInput} sheet - Original sheet input, used to find which
 * cells were date values.
 * @returns {void}
 *
 * Side effects: mutates numFmt on affected cells.
 */
function applyDateFormats(
  worksheet: ExcelJS.Worksheet,
  sheet: XlsxSheetInput,
): void {
  const firstDataRowNumber = sheet.headers ? 2 : 1;

  sheet.rows.forEach(
    (row, rowIndex) => {
      row.forEach(
        (value, columnIndex) => {
          if (isDateCellValue(value)) {
            worksheet
              .getRow(
                firstDataRowNumber + rowIndex,
              )
              .getCell(
                columnIndex + 1,
              ).numFmt = "yyyy-mm-dd";
          }
        },
      );
    },
  );
}

/**
 * Auto-sizes every column in a worksheet based on the display width of its
 * header (if any) and data cells, clamped to a sensible min/max range.
 *
 * @param {ExcelJS.Worksheet} worksheet - Worksheet already populated with
 * rows.
 * @param {XlsxSheetInput} sheet - Original sheet input used to measure
 * content width.
 * @returns {void}
 *
 * Side effects: mutates each column's `width`.
 */
function autoSizeColumns(
  worksheet: ExcelJS.Worksheet,
  sheet: XlsxSheetInput,
): void {
  const columnCount = Math.max(
    sheet.headers?.length ?? 0,
    ...sheet.rows.map((row) => row.length),
    1,
  );

  for (
    let columnIndex = 0;
    columnIndex < columnCount;
    columnIndex++
  ) {
    const headerLength =
      sheet.headers?.[columnIndex]?.length ?? 0;

    const maxRowLength = sheet.rows.reduce(
      (max, row) => {
        const cell = row[columnIndex];

        return cell === undefined
          ? max
          : Math.max(
              max,
              cellValueDisplayLength(cell),
            );
      },
      0,
    );

    const rawWidth =
      Math.max(headerLength, maxRowLength) + 2;

    const clampedWidth = Math.min(
      Math.max(rawWidth, MIN_COLUMN_WIDTH),
      MAX_COLUMN_WIDTH,
    );

    // See EXCELJS_DEFAULT_COLUMN_WIDTH: a width that exactly matches
    // exceljs's own default is otherwise discarded rather than saved. The
    // nudge is far smaller than one character cell and has no visible
    // effect on the rendered column.
    worksheet.getColumn(columnIndex + 1).width =
      clampedWidth === EXCELJS_DEFAULT_COLUMN_WIDTH
        ? clampedWidth + 0.01
        : clampedWidth;
  }
}

/**
 * Adds one fully populated, styled worksheet to a workbook.
 *
 * @param {ExcelJS.Workbook} workbook - Workbook to add the sheet to.
 * @param {XlsxSheetInput} sheet - Validated sheet definition.
 * @returns {void}
 * @throws {Error} If a date cell's ISO string cannot be parsed.
 *
 * Side effects: adds a worksheet to workbook.
 */
function addWorksheetFromInput(
  workbook: ExcelJS.Workbook,
  sheet: XlsxSheetInput,
): void {
  const worksheet = workbook.addWorksheet(
    sheet.name,
  );

  if (sheet.headers) {
    worksheet.addRow(sheet.headers);
  }

  for (const row of sheet.rows) {
    worksheet.addRow(
      row.map(toExcelCellValue),
    );
  }

  styleWorksheet(
    worksheet,
    Boolean(sheet.headers),
  );

  applyDateFormats(worksheet, sheet);
  autoSizeColumns(worksheet, sheet);
}

/**
 * Builds a complete, finished XLSX workbook from validated sheet data.
 *
 * @param {XlsxSheetInput[]} sheets - One or more worksheet definitions.
 * @returns {Promise<Buffer>} Finished workbook bytes.
 * @throws {Error} If any date cell's ISO string cannot be parsed, or the
 * exceljs package cannot write the resulting workbook.
 */
async function buildXlsxBuffer(
  sheets: XlsxSheetInput[],
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();

  for (const sheet of sheets) {
    addWorksheetFromInput(workbook, sheet);
  }

  const arrayBuffer = await workbook.xlsx.writeBuffer();

  return Buffer.from(arrayBuffer);
}

/**
 * Structural validation for a just-written XLSX file: confirms it is a
 * genuine Office Open XML package by opening it as a zip, checking for the
 * required `xl/workbook.xml` part, and confirming the number of worksheet
 * parts matches the number of sheets requested.
 *
 * @param {string} resolvedPath - Path of the file to validate.
 * @param {number} expectedSheetCount - Number of sheets that should be
 * present.
 * @returns {Promise<void>} Resolves if validation passes.
 * @throws {Error} If the file is not a valid zip, is missing
 * `xl/workbook.xml`, or has a different number of worksheet parts than
 * expected.
 */
async function validateXlsxStructure(
  resolvedPath: string,
  expectedSheetCount: number,
): Promise<void> {
  const { readFile } = await import(
    "node:fs/promises"
  );
  const JSZip = (
    await import("jszip")
  ).default;

  const buffer = await readFile(
    resolvedPath,
  );

  let zip;

  try {
    zip = await JSZip.loadAsync(
      buffer,
    );
  } catch (error) {
    throw new Error(
      `The generated XLSX file is not a valid zip package: ${
        error instanceof Error
          ? error.message
          : String(error)
      }`,
    );
  }

  if (!zip.file("xl/workbook.xml")) {
    throw new Error(
      "The generated XLSX file is missing xl/workbook.xml and is not a valid Excel workbook.",
    );
  }

  const worksheetParts = Object.keys(
    zip.files,
  ).filter((path) =>
    /^xl\/worksheets\/sheet\d+\.xml$/.test(
      path,
    ),
  );

  if (worksheetParts.length !== expectedSheetCount) {
    throw new Error(
      `The generated XLSX file has ${worksheetParts.length} worksheet part(s), expected ${expectedSheetCount}.`,
    );
  }
}

/**
 * Creates an XLSX file at the requested path from the given sheet data.
 *
 * @param {string} workingDirectory - Base directory for a relative
 * inputPath.
 * @param {CreateXlsxArgs} args - Validated create_xlsx arguments (path and
 * sheets).
 * @returns {Promise<CreateDocumentFileResult>} Resolved path and size of the
 * finished document.
 * @throws {Error} If the destination already exists, a date cell cannot be
 * parsed, the file cannot be written, or structural validation fails.
 *
 * Side effects: creates a new file on disk (and removes it again if
 * structural validation fails).
 */
export async function createXlsxFile(
  workingDirectory: string,
  args: CreateXlsxArgs,
): Promise<CreateDocumentFileResult> {
  return createDocumentFile({
    inputPath: args.path,
    workingDirectory,
    build: () => buildXlsxBuffer(args.sheets),
    validate: (resolvedPath) =>
      validateXlsxStructure(
        resolvedPath,
        args.sheets.length,
      ),
  });
}
