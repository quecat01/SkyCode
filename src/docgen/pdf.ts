/**
 * PDF generation for Sky Code's create_pdf tool.
 *
 * Converts the shared Markdown document structure (markdown.ts, the same
 * parser create_docx uses) into a real PDF using `pdfkit` (by way of
 * `pdfkit-table`, which adds table support on top of a normal pdfkit
 * document) and writes it through the shared document-generation utility
 * (shared.ts). Every use of `pdfkit`/`pdfkit-table` is confined to this
 * file, in line with the project's general practice of isolating a single
 * external library's API surface to one file per document format.
 *
 * Page margins and the page-number footer are fixed defaults rather than
 * arguments (see the create_pdf tool schema in tools.ts), matching docx.ts
 * and keeping the model-facing schema to just a destination path and
 * Markdown content.
 */

import {
  PDFDocumentWithTables,
} from "pdfkit-table";

import {
  createDocumentFile,
  type CreateDocumentFileResult,
} from "./shared.js";

import {
  parseMarkdownContent,
  type DocBlock,
  type TextRun,
} from "./markdown.js";

import type {
  CreatePdfArgs,
} from "../tools.js";

/** Page margin on every side, in points (1 inch), matching docx.ts. */
const PAGE_MARGIN_POINTS = 72;

/** Body paragraph and list-item font size, in points. */
const BODY_FONT_SIZE = 11;

/** Font size used for the document title (the first level-1 heading). */
const TITLE_FONT_SIZE = 24;

/** Font sizes for headings that are not the document title, by level. */
const HEADING_FONT_SIZES: Record<number, number> = {
  1: 18,
  2: 16,
  3: 14,
  4: 12,
  5: 11,
  6: 11,
};

/** Vertical space, in points, left below every block. */
const BLOCK_SPACING_POINTS = 10;

/** Standard PDF base-14 fonts used for run formatting; no embedding needed. */
const FONT_REGULAR = "Helvetica";
const FONT_BOLD = "Helvetica-Bold";
const FONT_ITALIC = "Helvetica-Oblique";
const FONT_BOLD_ITALIC = "Helvetica-BoldOblique";
const FONT_CODE = "Courier";

/**
 * Picks the standard font for one text run based on its bold/italic/code
 * flags. Code takes precedence over bold/italic (there is no bold-italic
 * monospace base-14 font), matching the plain, terse styling used elsewhere
 * in Sky Code's generated documents.
 *
 * @param {TextRun} run - Formatted run from markdown.ts.
 * @returns {string} Name of a pdfkit base-14 font.
 */
function fontForRun(
  run: TextRun,
): string {
  if (run.code) {
    return FONT_CODE;
  }

  if (run.bold && run.italic) {
    return FONT_BOLD_ITALIC;
  }

  if (run.bold) {
    return FONT_BOLD;
  }

  if (run.italic) {
    return FONT_ITALIC;
  }

  return FONT_REGULAR;
}

/**
 * Writes a list of formatted runs as one continuous line of text, switching
 * fonts between runs so bold/italic/code segments render correctly within a
 * single paragraph or heading.
 *
 * pdfkit has no native rich-text run API; `{ continued: true }` is its
 * documented mechanism for appending differently-styled text segments to the
 * same line without pdfkit inserting its own line break between them.
 *
 * @param {InstanceType<typeof PDFDocumentWithTables>} doc - Active PDF
 * document being built.
 * @param {TextRun[]} runs - Formatted runs to write.
 * @param {number} fontSize - Font size applied to every run.
 * @returns {void}
 *
 * Side effects: writes text to the current position in doc.
 */
function writeRuns(
  doc: InstanceType<typeof PDFDocumentWithTables>,
  runs: TextRun[],
  fontSize: number,
): void {
  if (runs.length === 0) {
    // An empty paragraph/heading still occupies a line; write a single space
    // so spacing stays consistent with non-empty blocks.
    doc
      .font(FONT_REGULAR)
      .fontSize(fontSize)
      .text(" ");

    return;
  }

  runs.forEach((run, index) => {
    const isLastRun = index === runs.length - 1;

    doc
      .font(fontForRun(run))
      .fontSize(fontSize)
      .text(
        run.text,
        {
          continued: !isLastRun,
        },
      );
  });
}

/**
 * Renders one parsed Markdown block into the PDF document, appending it at
 * the document's current vertical position.
 *
 * @param {InstanceType<typeof PDFDocumentWithTables>} doc - Active PDF
 * document being built.
 * @param {DocBlock} block - Parsed block from markdown.ts.
 * @param {boolean} isDocumentTitle - True when this block is the document's
 * first level-1 heading, rendered larger than any other heading level.
 * @returns {Promise<void>} Resolves once the block (and, for tables, its
 * asynchronous layout) has been written.
 * @throws {Error} If pdfkit-table cannot lay out a table block.
 *
 * Side effects: writes content to doc.
 */
async function writeBlock(
  doc: InstanceType<typeof PDFDocumentWithTables>,
  block: DocBlock,
  isDocumentTitle: boolean,
): Promise<void> {
  switch (block.type) {
    case "heading": {
      const fontSize = isDocumentTitle
        ? TITLE_FONT_SIZE
        : (HEADING_FONT_SIZES[block.level] ??
            HEADING_FONT_SIZES[6]);

      // Headings render fully bold regardless of the source Markdown's own
      // inline emphasis, matching normal heading presentation; italics
      // within a heading are still respected via fontForRun.
      writeRuns(
        doc,
        block.runs.map((run) => ({
          ...run,
          bold: true,
        })),
        fontSize,
      );

      break;
    }

    case "paragraph": {
      writeRuns(
        doc,
        block.runs,
        BODY_FONT_SIZE,
      );

      break;
    }

    case "bulletList": {
      for (const itemRuns of block.items) {
        doc
          .font(FONT_REGULAR)
          .fontSize(BODY_FONT_SIZE)
          .text("• ", {
            continued: true,
          });

        writeRuns(
          doc,
          itemRuns,
          BODY_FONT_SIZE,
        );
      }

      break;
    }

    case "numberedList": {
      block.items.forEach(
        (itemRuns, index) => {
          doc
            .font(FONT_REGULAR)
            .fontSize(BODY_FONT_SIZE)
            .text(`${index + 1}. `, {
              continued: true,
            });

          writeRuns(
            doc,
            itemRuns,
            BODY_FONT_SIZE,
          );
        },
      );

      break;
    }

    case "table": {
      await doc.table({
        headers: block.header,
        rows: block.rows,
      });

      break;
    }
  }
}

/**
 * Draws a centered page-number footer on every page already added to the
 * document.
 *
 * Called once, after all content has been written, because pdfkit does not
 * know a document's final page count until then; `bufferPages: true` (set
 * when the document is constructed) keeps every page available for this
 * pass instead of flushing each one to the output stream as soon as the
 * next page starts.
 *
 * The footer is drawn inside the page's bottom margin, below the normal
 * content area. pdfkit auto-paginates any `.text()` call whose position
 * falls outside the current page's margin-defined content box, so drawing
 * directly at that y position would otherwise make pdfkit silently start a
 * new (blank, footer-only) page for every page this function touches. The
 * bottom margin is temporarily set to 0 for each page while its footer is
 * drawn, and restored immediately after, which is pdfkit's own documented
 * way to write into the margin area intentionally.
 *
 * @param {InstanceType<typeof PDFDocumentWithTables>} doc - Finished PDF
 * document, constructed with `bufferPages: true`.
 * @returns {void}
 *
 * Side effects: draws text on every buffered page and flushes them to the
 * document's output stream.
 */
function drawPageNumberFooters(
  doc: InstanceType<typeof PDFDocumentWithTables>,
): void {
  const range = doc.bufferedPageRange();

  for (
    let pageIndex = 0;
    pageIndex < range.count;
    pageIndex++
  ) {
    doc.switchToPage(pageIndex);

    const originalBottomMargin =
      doc.page.margins.bottom;

    doc.page.margins.bottom = 0;

    doc
      .font(FONT_REGULAR)
      .fontSize(9)
      .text(
        `${pageIndex + 1}`,
        PAGE_MARGIN_POINTS,
        doc.page.height - PAGE_MARGIN_POINTS / 2,
        {
          align: "center",
          width:
            doc.page.width -
            PAGE_MARGIN_POINTS * 2,
        },
      );

    doc.page.margins.bottom =
      originalBottomMargin;
  }

  doc.flushPages();
}

/**
 * Builds a complete, finished PDF file from Markdown content.
 *
 * @param {string} markdown - Markdown source (see the supported subset
 * documented in markdown.ts and the create_pdf schema in tools.ts).
 * @returns {Promise<Buffer>} Finished PDF bytes.
 * @throws {Error} If the Markdown cannot be parsed or pdfkit/pdfkit-table
 * fails while building the document.
 */
async function buildPdfBuffer(
  markdown: string,
): Promise<Buffer> {
  const blocks = parseMarkdownContent(
    markdown,
  );

  const doc = new PDFDocumentWithTables({
    margin: PAGE_MARGIN_POINTS,
    bufferPages: true,
  });

  const chunks: Buffer[] = [];

  doc.on(
    "data",
    (chunk: Buffer) => {
      chunks.push(chunk);
    },
  );

  const finished = new Promise<Buffer>(
    (resolve, reject) => {
      doc.on("end", () => {
        resolve(Buffer.concat(chunks));
      });

      doc.on("error", reject);
    },
  );

  doc.fontSize(BODY_FONT_SIZE).font(
    FONT_REGULAR,
  );

  let sawDocumentTitle = false;

  for (const block of blocks) {
    const isDocumentTitle =
      block.type === "heading" &&
      block.level === 1 &&
      !sawDocumentTitle;

    if (isDocumentTitle) {
      sawDocumentTitle = true;
    }

    await writeBlock(
      doc,
      block,
      isDocumentTitle,
    );

    doc.moveDown(
      BLOCK_SPACING_POINTS / doc.currentLineHeight(),
    );
  }

  drawPageNumberFooters(doc);

  doc.end();

  return finished;
}

/**
 * Cheap structural validation for a just-written PDF file: PDF is not a
 * zip-based format, so validation here is limited to confirming the file
 * starts with a PDF header and ends with the standard end-of-file marker,
 * rather than fully parsing the file's object structure.
 *
 * @param {string} resolvedPath - Path of the file to validate.
 * @returns {Promise<void>} Resolves if validation passes.
 * @throws {Error} If the file is missing the `%PDF-` header or the `%%EOF`
 * trailer.
 */
async function validatePdfStructure(
  resolvedPath: string,
): Promise<void> {
  const { readFile } = await import(
    "node:fs/promises"
  );

  const buffer = await readFile(
    resolvedPath,
  );

  const header = buffer
    .subarray(0, 5)
    .toString("latin1");

  if (header !== "%PDF-") {
    throw new Error(
      "The generated PDF file is missing the %PDF- header and is not a valid PDF.",
    );
  }

  // The trailer marker is not necessarily the very last bytes (some writers
  // add trailing whitespace/newlines), so this checks a small tail window
  // rather than only the final bytes.
  const tail = buffer
    .subarray(-1024)
    .toString("latin1");

  if (!tail.includes("%%EOF")) {
    throw new Error(
      "The generated PDF file is missing the %%EOF trailer and is not a valid PDF.",
    );
  }
}

/**
 * Creates a PDF file at the requested path from Markdown content.
 *
 * @param {string} workingDirectory - Base directory for a relative
 * args.path.
 * @param {CreatePdfArgs} args - Validated create_pdf arguments (path and
 * Markdown content).
 * @returns {Promise<CreateDocumentFileResult>} Resolved path and size of the
 * finished document.
 * @throws {Error} If the destination already exists, the Markdown cannot be
 * converted, the file cannot be written, or structural validation fails.
 *
 * Side effects: creates a new file on disk (and removes it again if
 * structural validation fails).
 */
export async function createPdfFile(
  workingDirectory: string,
  args: CreatePdfArgs,
): Promise<CreateDocumentFileResult> {
  return createDocumentFile({
    inputPath: args.path,
    workingDirectory,
    build: () =>
      buildPdfBuffer(args.content),
    validate: validatePdfStructure,
  });
}
