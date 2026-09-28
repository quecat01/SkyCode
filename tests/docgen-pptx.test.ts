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
  createPptxFile,
} from "../src/docgen/pptx.ts";

/** A minimal valid 1x1 red PNG, used for image-slide tests. */
const ONE_PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

describe(
  "docgen/pptx.ts createPptxFile",
  () => {
    let testDirectory:
      string;

    beforeEach(
      async () => {
        testDirectory =
          await mkdtemp(
            join(
              tmpdir(),
              "sky-code-docgen-pptx-",
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
      "creates a valid Office Open XML package with one slide part per requested slide",
      async () => {
        const result =
          await createPptxFile(
            testDirectory,
            {
              path:
                "deck.pptx",
              slides: [
                {
                  type: "title",
                  title:
                    "Electrical Service Upgrade",
                },
                {
                  type: "content",
                  title:
                    "Scope",
                  bullets: [
                    "Remove 100A panel",
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

        expect(
          zip.file(
            "ppt/presentation.xml",
          ),
        ).not.toBeNull();

        const slideParts =
          Object.keys(
            zip.files,
          ).filter((path) =>
            /^ppt\/slides\/slide\d+\.xml$/.test(
              path,
            ),
          );

        expect(
          slideParts,
        ).toHaveLength(
          2,
        );
      },
    );

    it(
      "renders a title slide's title, subtitle, and detail bullets",
      async () => {
        const result =
          await createPptxFile(
            testDirectory,
            {
              path:
                "title-slide.pptx",
              slides: [
                {
                  type: "title",
                  title:
                    "Electrical Service Upgrade",
                  subtitle:
                    "Prepared for Daniel Mercer",
                  bullets: [
                    "Contractor: Rebecca Stone",
                    "CAD 3,250",
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

        const slide1 =
          await zip
            .file(
              "ppt/slides/slide1.xml",
            )!
            .async(
              "string",
            );

        expect(
          slide1,
        ).toContain(
          "Electrical Service Upgrade",
        );

        expect(
          slide1,
        ).toContain(
          "Daniel Mercer",
        );

        expect(
          slide1,
        ).toContain(
          "Rebecca Stone",
        );

        expect(
          slide1,
        ).toContain(
          "3,250",
        );
      },
    );

    it(
      "renders a content slide's bullets and table",
      async () => {
        const result =
          await createPptxFile(
            testDirectory,
            {
              path:
                "content-slide.pptx",
              slides: [
                {
                  type: "content",
                  title:
                    "Scope of Work",
                  bullets: [
                    "Remove 100A panel",
                    "Install 200A panel",
                  ],
                  table: {
                    headers: [
                      "Item",
                      "Amount",
                    ],
                    rows: [
                      [
                        "Panel upgrade",
                        "CAD 3,250",
                      ],
                    ],
                  },
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

        const slide1 =
          await zip
            .file(
              "ppt/slides/slide1.xml",
            )!
            .async(
              "string",
            );

        expect(
          slide1,
        ).toContain(
          "Scope of Work",
        );

        expect(
          slide1,
        ).toContain(
          "100A",
        );

        expect(
          slide1,
        ).toContain(
          "200A",
        );

        expect(
          slide1,
        ).toContain(
          "3,250",
        );
      },
    );

    it(
      "renders a chart slide with a native chart carrying the real numeric values",
      async () => {
        const result =
          await createPptxFile(
            testDirectory,
            {
              path:
                "chart-slide.pptx",
              slides: [
                {
                  type: "chart",
                  title:
                    "Amperage Comparison",
                  categories: [
                    "Existing",
                    "Proposed",
                  ],
                  series: [
                    {
                      name: "Amperage",
                      values: [
                        100,
                        200,
                      ],
                    },
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

        const chartParts =
          Object.keys(
            zip.files,
          ).filter((path) =>
            /^ppt\/charts\/chart\d+\.xml$/.test(
              path,
            ),
          );

        expect(
          chartParts,
        ).toHaveLength(
          1,
        );

        const chartXml =
          await zip
            .file(
              chartParts[0]!,
            )!
            .async(
              "string",
            );

        const values = [
          ...chartXml.matchAll(
            /<c:v>([\d.]+)<\/c:v>/g,
          ),
        ].map(
          (match) =>
            match[1],
        );

        expect(
          values,
        ).toContain(
          "100",
        );

        expect(
          values,
        ).toContain(
          "200",
        );

        // A native bar chart plotted from these two raw values renders the
        // 200 bar at exactly twice the 100 bar's height: PowerPoint (and
        // pptxgenjs) scale a bar chart's value axis linearly from zero by
        // default, and this file sets no axis min/max that would break that
        // proportionality (see renderChartSlide in pptx.ts).
        expect(
          Number(
            values[
              values.indexOf(
                "200",
              )
            ],
          ),
        ).toBe(
          Number(
            values[
              values.indexOf(
                "100",
              )
            ],
          ) * 2,
        );
      },
    );

    it(
      "embeds an accepted image format and its caption on a content slide",
      async () => {
        const imagePath =
          join(
            testDirectory,
            "swatch.png",
          );

        await writeFile(
          imagePath,
          Buffer.from(
            ONE_PIXEL_PNG_BASE64,
            "base64",
          ),
        );

        const result =
          await createPptxFile(
            testDirectory,
            {
              path:
                "image-slide.pptx",
              slides: [
                {
                  type: "content",
                  image: {
                    path:
                      "swatch.png",
                    caption:
                      "Color swatch",
                  },
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

        const mediaParts =
          Object.keys(
            zip.files,
          ).filter((path) =>
            path.startsWith(
              "ppt/media/",
            ) &&
            !path.endsWith(
              "/",
            ),
          );

        expect(
          mediaParts.length,
        ).toBeGreaterThan(
          0,
        );

        const slide1 =
          await zip
            .file(
              "ppt/slides/slide1.xml",
            )!
            .async(
              "string",
            );

        expect(
          slide1,
        ).toContain(
          "Color swatch",
        );
      },
    );

    it(
      "rejects an image whose extension is not in the accepted format allowlist",
      async () => {
        const imagePath =
          join(
            testDirectory,
            "diagram.svg",
          );

        await writeFile(
          imagePath,
          "<svg></svg>",
        );

        const targetPath =
          join(
            testDirectory,
            "svg-image.pptx",
          );

        await expect(
          createPptxFile(
            testDirectory,
            {
              path:
                "svg-image.pptx",
              slides: [
                {
                  type: "content",
                  image: {
                    path:
                      "diagram.svg",
                  },
                },
              ],
            },
          ),
        ).rejects.toThrow(
          "unsupported image extension",
        );

        await expect(
          readFile(
            targetPath,
          ),
        ).rejects.toThrow();
      },
    );

    it(
      "rejects when the destination file already exists and does not overwrite it",
      async () => {
        const existingPath =
          join(
            testDirectory,
            "already-there.pptx",
          );

        await writeFile(
          existingPath,
          "not a real pptx",
        );

        await expect(
          createPptxFile(
            testDirectory,
            {
              path:
                "already-there.pptx",
              slides: [
                {
                  type: "title",
                  title:
                    "New Deck",
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
          "not a real pptx",
        );
      },
    );
  },
);
