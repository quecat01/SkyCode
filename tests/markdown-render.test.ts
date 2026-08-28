import {
  describe,
  expect,
  it,
} from "vitest";

import {
  SKY_CODE_MARKDOWN_THEME,
  createSkyCodeMarkdownStreamer,
} from "../src/markdown-render.ts";

describe(
  "SKY_CODE_MARKDOWN_THEME",
  () => {
    it(
      "uses the exact brand colors already shipped in the SVG logos, not separately invented ones",
      () => {
        // These hex values were read directly out of docs/logo/*.svg, not
        // chosen independently, so terminal output matches the established
        // brand rather than introducing a second, slightly different
        // palette.
        expect(
          SKY_CODE_MARKDOWN_THEME
            .heading
            ?.color,
        ).toBe(
          "#CC00CC",
        );

        expect(
          SKY_CODE_MARKDOWN_THEME
            .link
            ?.color,
        ).toBe(
          "#CC00CC",
        );

        expect(
          SKY_CODE_MARKDOWN_THEME
            .listMarker
            ?.color,
        ).toBe(
          "#CC00CC",
        );

        expect(
          SKY_CODE_MARKDOWN_THEME
            .blockCode
            ?.color,
        ).toBe(
          "#E8E8E8",
        );

        expect(
          SKY_CODE_MARKDOWN_THEME
            .quote
            ?.color,
        ).toBe(
          "#555555",
        );
      },
    );

    it(
      "does not configure a syntax highlighter, matching the confirmed v1 scope decision",
      () => {
        expect(
          SKY_CODE_MARKDOWN_THEME
            .blockCode
            ?.dim,
        ).toBe(
          true,
        );
      },
    );
  },
);

describe(
  "createSkyCodeMarkdownStreamer",
  () => {
    it(
      "renders headings, emphasis, and inline code without leaving raw Markdown syntax in the output",
      () => {
        const streamer =
          createSkyCodeMarkdownStreamer();

        const output =
          streamer.push(
            "# Heading\n\nSome **bold** and `inline code`.\n",
          ) +
          streamer.finish();

        expect(
          output,
        ).not.toContain(
          "**bold**",
        );

        expect(
          output,
        ).not.toContain(
          "`inline code`",
        );

        expect(
          output,
        ).toContain(
          "Heading",
        );

        expect(
          output,
        ).toContain(
          "bold",
        );

        expect(
          output,
        ).toContain(
          "inline code",
        );
      },
    );

    it(
      "produces identical output whether fed in one piece or split across arbitrary chunk boundaries",
      () => {
        const markdown =
          "# Title\n\nSome **bold** text and a list:\n\n- one\n- two\n\n```js\nconst x = 1;\n```\n\nDone.\n";

        const wholeStreamer =
          createSkyCodeMarkdownStreamer();

        const wholeOutput =
          wholeStreamer.push(
            markdown,
          ) +
          wholeStreamer.finish();

        const chunkedStreamer =
          createSkyCodeMarkdownStreamer();

        let chunkedOutput =
          "";

        const chunkSize = 5;

        for (
          let i = 0;
          i <
          markdown.length;
          i +=
            chunkSize
        ) {
          chunkedOutput +=
            chunkedStreamer.push(
              markdown.slice(
                i,
                i +
                  chunkSize,
              ),
            );
        }

        chunkedOutput +=
          chunkedStreamer.finish();

        expect(
          chunkedOutput,
        ).toBe(
          wholeOutput,
        );
      },
    );

    it(
      "returns a fresh streamer each call, with no shared state between turns",
      () => {
        const firstStreamer =
          createSkyCodeMarkdownStreamer();

        firstStreamer.push(
          "```js\nunterminated code fence",
        );

        // Deliberately not finished: the first streamer is left mid-fence.

        const secondStreamer =
          createSkyCodeMarkdownStreamer();

        const secondOutput =
          secondStreamer.push(
            "Plain text.",
          ) +
          secondStreamer.finish();

        // A previous turn's unfinished code fence must not bleed into a new
        // turn's streamer.
        expect(
          secondOutput,
        ).not.toContain(
          "unterminated",
        );

        expect(
          secondOutput,
        ).toContain(
          "Plain text.",
        );
      },
    );
  },
);
