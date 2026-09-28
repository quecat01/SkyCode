/**
 * PPTX generation for Sky Code's create_pptx tool.
 *
 * Builds a real PowerPoint presentation from the model's slide definitions
 * using the `pptxgenjs` package and writes it through the shared
 * document-generation utility (shared.ts). Every use of `pptxgenjs` is
 * confined to this file, in line with the project's general practice of
 * isolating a single external library's API surface to one file per
 * document format.
 *
 * Three slide templates are supported (see PptxSlideInput in tools.ts):
 * title, content (heading/bullets/table/image), and chart (a native,
 * editable bar chart). A chart slide's bars are rendered by pptxgenjs from
 * the real numeric values handed to it, so a value of 200 renders exactly
 * twice as tall as a value of 100 without any manual scaling on this file's
 * part; PowerPoint (and pptxgenjs) scale a bar chart's category axis
 * linearly from zero by default.
 *
 * Only PNG, JPEG, GIF, and BMP images are accepted for a content slide's
 * image (see validateImageFormat below): this sidesteps a set of unpatched
 * denial-of-service advisories in an `image-size` dependency of pptxgenjs
 * that only affect other, less common image formats it also parses.
 */

import PptxGenJSCtorValue from "pptxgenjs";

import {
  createDocumentFile,
  type CreateDocumentFileResult,
} from "./shared.js";

import {
  resolveFilePath,
} from "../fileops.js";

import type {
  CreatePptxArgs,
  PptxChartSlide,
  PptxContentSlide,
  PptxSlideInput,
  PptxTitleSlide,
} from "../tools.js";

// pptxgenjs's shipped .d.ts was written for TypeScript's older, "classic"
// module resolution and does not resolve correctly under this project's
// Node16/NodeNext resolution: a normal `import PptxGenJS from "pptxgenjs"`
// types as the whole module namespace rather than the class it actually
// declares as its default export, even though that same import correctly
// gives the real class at runtime (verified directly against compiled
// output). Referencing the class through a type-only `import("pptxgenjs")`
// query, as done below, resolves correctly; only the single runtime
// constructor value needs an explicit cast back to that type.
type PptxGenJSInstance = import("pptxgenjs").default;
type PptxSlide = ReturnType<PptxGenJSInstance["addSlide"]>;
type PptxTextPropsOptions =
  import("pptxgenjs").default.TextPropsOptions;
type PptxTableRow =
  import("pptxgenjs").default.TableRow;
type PptxChartOpts =
  import("pptxgenjs").default.IChartOpts;

const PptxGenJS =
  PptxGenJSCtorValue as unknown as new () => PptxGenJSInstance;

/**
 * Image file extensions (lowercase, without the leading dot) accepted by
 * create_pptx, and the mime subtype pptxgenjs should treat each one as. See
 * this file's top-level doc comment for why the accepted set is
 * deliberately narrow.
 */
const ALLOWED_IMAGE_EXTENSIONS: Record<
  string,
  string
> = {
  png: "png",
  jpg: "jpeg",
  jpeg: "jpeg",
  gif: "gif",
  bmp: "bmp",
};

/** Slide width/height in inches (pptxgenjs's standard 16:9 "LAYOUT_16x9"). */
const SLIDE_WIDTH_IN = 10;
const SLIDE_MARGIN_IN = 0.5;

/**
 * Extracts a lowercase file extension (without the leading dot) from a
 * path, ignoring any query string or fragment.
 *
 * @param {string} path - File path or URL-like path.
 * @returns {string} Lowercase extension, or an empty string if none.
 */
function extensionOf(
  path: string,
): string {
  const lastSegment =
    path.split(/[?#]/)[0] ?? path;

  const dotIndex =
    lastSegment.lastIndexOf(".");

  if (dotIndex === -1) {
    return "";
  }

  return lastSegment
    .slice(dotIndex + 1)
    .toLowerCase();
}

/**
 * Reads an image file from disk and returns it as a pptxgenjs-compatible
 * base64 data string, after confirming its extension is one of the accepted
 * formats.
 *
 * @param {string} imagePath - Path supplied by the model for a content
 * slide's image.
 * @param {string} workingDirectory - Base directory for a relative
 * imagePath.
 * @returns {Promise<string>} A `image/<subtype>;base64,<data>` string ready
 * to pass as pptxgenjs's ImageProps.data.
 * @throws {Error} If the extension is not one of ALLOWED_IMAGE_EXTENSIONS,
 * or the file cannot be read.
 */
async function readImageAsDataUri(
  imagePath: string,
  workingDirectory: string,
): Promise<string> {
  const extension = extensionOf(
    imagePath,
  );

  const mimeSubtype =
    ALLOWED_IMAGE_EXTENSIONS[extension];

  if (!mimeSubtype) {
    const allowed = Object.keys(
      ALLOWED_IMAGE_EXTENSIONS,
    ).join(", ");

    throw new Error(
      `"${imagePath}" has an unsupported image extension. create_pptx only accepts: ${allowed}.`,
    );
  }

  const resolvedPath = resolveFilePath(
    imagePath,
    workingDirectory,
  );

  const { readFile } = await import(
    "node:fs/promises"
  );

  const bytes = await readFile(
    resolvedPath,
  );

  return `image/${mimeSubtype};base64,${bytes.toString(
    "base64",
  )}`;
}

/**
 * Renders a title-template slide: a large centered title, optional
 * subtitle, and optional short detail lines.
 *
 * @param {PptxSlide} slide - Newly added, empty slide.
 * @param {PptxTitleSlide} input - Validated title slide definition.
 * @returns {void}
 *
 * Side effects: adds text objects to slide.
 */
function renderTitleSlide(
  slide: PptxSlide,
  input: PptxTitleSlide,
): void {
  slide.addText(input.title, {
    x: SLIDE_MARGIN_IN,
    y: 1.6,
    w: SLIDE_WIDTH_IN - SLIDE_MARGIN_IN * 2,
    h: 1.2,
    align: "center",
    fontSize: 32,
    bold: true,
  });

  let nextY = 2.9;

  if (input.subtitle) {
    slide.addText(input.subtitle, {
      x: SLIDE_MARGIN_IN,
      y: nextY,
      w: SLIDE_WIDTH_IN - SLIDE_MARGIN_IN * 2,
      h: 0.6,
      align: "center",
      fontSize: 18,
      italic: true,
    });

    nextY += 0.7;
  }

  if (input.bullets && input.bullets.length > 0) {
    const bulletProps: PptxTextPropsOptions =
      {
        x: SLIDE_MARGIN_IN,
        y: nextY,
        w: SLIDE_WIDTH_IN - SLIDE_MARGIN_IN * 2,
        h: 0.35 * input.bullets.length,
        align: "center",
        fontSize: 14,
      };

    slide.addText(
      input.bullets.map((line) => ({
        text: line,
        options: {
          breakLine: true,
        },
      })),
      bulletProps,
    );
  }
}

/**
 * Renders a content-template slide: optional heading, bullet list, table,
 * and image, stacked top to bottom in that order.
 *
 * @param {PptxSlide} slide - Newly added, empty slide.
 * @param {PptxContentSlide} input - Validated content slide definition.
 * @param {string} workingDirectory - Base directory for a relative image
 * path.
 * @returns {Promise<void>} Resolves once every provided element has been
 * added.
 * @throws {Error} If an image is provided with an unsupported extension or
 * cannot be read.
 *
 * Side effects: adds text, table, and/or image objects to slide; reads an
 * image file from disk when input.image is present.
 */
async function renderContentSlide(
  slide: PptxSlide,
  input: PptxContentSlide,
  workingDirectory: string,
): Promise<void> {
  let nextY = SLIDE_MARGIN_IN;

  if (input.title) {
    slide.addText(input.title, {
      x: SLIDE_MARGIN_IN,
      y: nextY,
      w: SLIDE_WIDTH_IN - SLIDE_MARGIN_IN * 2,
      h: 0.7,
      fontSize: 24,
      bold: true,
    });

    nextY += 0.85;
  }

  if (input.bullets && input.bullets.length > 0) {
    slide.addText(
      input.bullets.map((line) => ({
        text: line,
        options: {
          bullet: true,
          breakLine: true,
        },
      })),
      {
        x: SLIDE_MARGIN_IN,
        y: nextY,
        w: SLIDE_WIDTH_IN - SLIDE_MARGIN_IN * 2,
        h: 0.4 * input.bullets.length,
        fontSize: 16,
      },
    );

    nextY += 0.4 * input.bullets.length + 0.2;
  }

  if (input.table) {
    const headerRow: PptxTableRow =
      input.table.headers.map(
        (text) => ({
          text,
          options: {
            bold: true,
            fill: {
              color: "D9D9D9",
            },
          },
        }),
      );

    const dataRows: PptxTableRow[] =
      input.table.rows.map((row) =>
        row.map((text) => ({
          text,
        })),
      );

    slide.addTable(
      [headerRow, ...dataRows],
      {
        x: SLIDE_MARGIN_IN,
        y: nextY,
        w: SLIDE_WIDTH_IN - SLIDE_MARGIN_IN * 2,
        fontSize: 12,
        border: {
          type: "solid",
          color: "BFBFBF",
          pt: 0.5,
        },
      },
    );

    nextY += 0.4 * (input.table.rows.length + 1) + 0.3;
  }

  if (input.image) {
    const data = await readImageAsDataUri(
      input.image.path,
      workingDirectory,
    );

    slide.addImage({
      data,
      x: SLIDE_MARGIN_IN,
      y: nextY,
      w: 4,
      h: 3,
    });

    if (input.image.caption) {
      slide.addText(
        input.image.caption,
        {
          x: SLIDE_MARGIN_IN,
          y: nextY + 3.05,
          w: 4,
          h: 0.35,
          fontSize: 11,
          italic: true,
          align: "center",
        },
      );
    }
  }
}

/**
 * Renders a chart-template slide: an optional heading and a native, editable
 * bar chart plotting one or more series against a shared category axis.
 *
 * @param {PptxGenJSInstance} pptx - Active presentation (needed for the
 * ChartType enum).
 * @param {PptxSlide} slide - Newly added, empty slide.
 * @param {PptxChartSlide} input - Validated chart slide definition.
 * @returns {void}
 *
 * Side effects: adds a text object (if titled) and a chart object to slide.
 */
function renderChartSlide(
  pptx: PptxGenJSInstance,
  slide: PptxSlide,
  input: PptxChartSlide,
): void {
  let chartY = SLIDE_MARGIN_IN;
  let chartH = 5;

  if (input.title) {
    slide.addText(input.title, {
      x: SLIDE_MARGIN_IN,
      y: SLIDE_MARGIN_IN,
      w: SLIDE_WIDTH_IN - SLIDE_MARGIN_IN * 2,
      h: 0.7,
      fontSize: 24,
      bold: true,
    });

    chartY = 1.35;
    chartH = 4.15;
  }

  const chartData = input.series.map(
    (series) => ({
      name: series.name,
      labels: input.categories,
      values: series.values,
    }),
  );

  const chartOptions: PptxChartOpts = {
    x: SLIDE_MARGIN_IN,
    y: chartY,
    w: SLIDE_WIDTH_IN - SLIDE_MARGIN_IN * 2,
    h: chartH,
    barDir: "col",
    showLegend: input.series.length > 1,
    showValue: true,
    catAxisTitle: undefined,
  };

  slide.addChart(
    pptx.ChartType.bar,
    chartData,
    chartOptions,
  );
}

/**
 * Builds a complete, finished PPTX file from validated slide definitions.
 *
 * @param {string} workingDirectory - Base directory for a relative image
 * path within a content slide.
 * @param {PptxSlideInput[]} slides - One or more validated slide
 * definitions, in presentation order.
 * @returns {Promise<Buffer>} Finished presentation bytes.
 * @throws {Error} If a content slide's image has an unsupported extension or
 * cannot be read, or pptxgenjs cannot write the resulting presentation.
 */
async function buildPptxBuffer(
  workingDirectory: string,
  slides: PptxSlideInput[],
): Promise<Buffer> {
  const pptx = new PptxGenJS();

  for (const slideInput of slides) {
    const slide = pptx.addSlide();

    switch (slideInput.type) {
      case "title":
        renderTitleSlide(
          slide,
          slideInput,
        );

        break;

      case "content":
        await renderContentSlide(
          slide,
          slideInput,
          workingDirectory,
        );

        break;

      case "chart":
        renderChartSlide(
          pptx,
          slide,
          slideInput,
        );

        break;
    }
  }

  const output = await pptx.write({
    outputType: "nodebuffer",
  });

  return output as Buffer;
}

/**
 * Structural validation for a just-written PPTX file: confirms it is a
 * genuine Office Open XML package by opening it as a zip, checking for the
 * required `ppt/presentation.xml` part, and confirming the number of slide
 * parts matches the number of slides requested.
 *
 * @param {string} resolvedPath - Path of the file to validate.
 * @param {number} expectedSlideCount - Number of slides that should be
 * present.
 * @returns {Promise<void>} Resolves if validation passes.
 * @throws {Error} If the file is not a valid zip, is missing
 * `ppt/presentation.xml`, or has a different number of slide parts than
 * expected.
 */
async function validatePptxStructure(
  resolvedPath: string,
  expectedSlideCount: number,
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
      `The generated PPTX file is not a valid zip package: ${
        error instanceof Error
          ? error.message
          : String(error)
      }`,
    );
  }

  if (
    !zip.file("ppt/presentation.xml")
  ) {
    throw new Error(
      "The generated PPTX file is missing ppt/presentation.xml and is not a valid PowerPoint presentation.",
    );
  }

  const slideParts = Object.keys(
    zip.files,
  ).filter((path) =>
    /^ppt\/slides\/slide\d+\.xml$/.test(
      path,
    ),
  );

  if (slideParts.length !== expectedSlideCount) {
    throw new Error(
      `The generated PPTX file has ${slideParts.length} slide part(s), expected ${expectedSlideCount}.`,
    );
  }
}

/**
 * Creates a PPTX file at the requested path from the given slide
 * definitions.
 *
 * @param {string} workingDirectory - Base directory for a relative
 * args.path and for any content slide's relative image path.
 * @param {CreatePptxArgs} args - Validated create_pptx arguments (path and
 * slides).
 * @returns {Promise<CreateDocumentFileResult>} Resolved path and size of the
 * finished document.
 * @throws {Error} If the destination already exists, an image cannot be
 * read or has an unsupported extension, the file cannot be written, or
 * structural validation fails.
 *
 * Side effects: creates a new file on disk (and removes it again if
 * structural validation fails); reads any image files referenced by content
 * slides.
 */
export async function createPptxFile(
  workingDirectory: string,
  args: CreatePptxArgs,
): Promise<CreateDocumentFileResult> {
  return createDocumentFile({
    inputPath: args.path,
    workingDirectory,
    build: () =>
      buildPptxBuffer(
        workingDirectory,
        args.slides,
      ),
    validate: (resolvedPath) =>
      validatePptxStructure(
        resolvedPath,
        args.slides.length,
      ),
  });
}
