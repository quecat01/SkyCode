import {
  describe,
  expect,
  it,
} from "vitest";

import {
  SkyToolMarkerBuffer,
} from "../src/sky-tool-marker-buffer.ts";

describe(
  "SkyToolMarkerBuffer",
  () => {
    it(
      "passes ordinary text straight through once the first chunk cannot be a marker prefix",
      () => {
        const buffer = new SkyToolMarkerBuffer();

        expect(buffer.push(
          "Hello there",
        )).toEqual({
          mode: "normal",
          textToDisplay: "Hello there",
        });
      },
    );

    it(
      "continues passing subsequent chunks straight through once in normal mode",
      () => {
        const buffer = new SkyToolMarkerBuffer();

        buffer.push(
          "Hello",
        );

        expect(buffer.push(
          " there",
        )).toEqual({
          mode: "normal",
          textToDisplay: " there",
        });
      },
    );

    it(
      "buffers a chunk that is still a strict prefix of the marker",
      () => {
        const buffer = new SkyToolMarkerBuffer();

        expect(buffer.push(
          "`",
        )).toEqual({
          mode: "undetermined",
          textToDisplay: "",
        });

        expect(buffer.push(
          "``",
        )).toEqual({
          mode: "undetermined",
          textToDisplay: "",
        });
      },
    );

    it(
      "detects a complete sky-tool marker split across multiple chunks and withholds it",
      () => {
        const buffer = new SkyToolMarkerBuffer();

        buffer.push(
          "```sky",
        );

        expect(buffer.push(
          "-tool\n",
        )).toEqual({
          mode: "tool",
          textToDisplay: "",
        });
      },
    );

    it(
      "keeps withholding all further chunks once tool mode is confirmed",
      () => {
        const buffer = new SkyToolMarkerBuffer();

        buffer.push(
          "```sky-tool\n",
        );

        expect(buffer.push(
          '{"tool":"read_file","args":{}}\n```',
        )).toEqual({
          mode: "tool",
          textToDisplay: "",
        });
      },
    );

    it(
      "releases all buffered text at once once it's clear the prefix cannot be a marker",
      () => {
        const buffer = new SkyToolMarkerBuffer();

        buffer.push(
          "`",
        );

        expect(buffer.push(
          "x",
        )).toEqual({
          mode: "normal",
          textToDisplay: "`x",
        });
      },
    );

    it(
      "tolerates leading whitespace before the marker",
      () => {
        const buffer = new SkyToolMarkerBuffer();

        expect(buffer.push(
          "   ```sky-tool\n",
        )).toEqual({
          mode: "tool",
          textToDisplay: "",
        });
      },
    );

    it(
      "does not resolve to tool mode from push() alone when the buffered text is exactly the marker with nothing more yet",
      () => {
        const buffer = new SkyToolMarkerBuffer();

        // Exactly the marker, no trailing character yet: still ambiguous,
        // since a real sky-tool block always has more content (at least a
        // newline) after the opening marker.
        expect(buffer.push(
          "```sky-tool",
        )).toEqual({
          mode: "undetermined",
          textToDisplay: "",
        });
      },
    );

    it(
      "finish() resolves an undetermined empty response (nothing ever streamed) to normal with nothing to display",
      () => {
        const buffer = new SkyToolMarkerBuffer();

        expect(buffer.finish()).toEqual({
          mode: "normal",
          textToDisplay: "",
        });
      },
    );

    it(
      "finish() resolves a short undetermined non-marker prefix to normal, releasing the buffered text",
      () => {
        const buffer = new SkyToolMarkerBuffer();

        buffer.push(
          "`",
        );

        expect(buffer.finish()).toEqual({
          mode: "normal",
          textToDisplay: "`",
        });
      },
    );

    it(
      "finish() resolves a stream that ends with exactly the complete marker and nothing more to tool mode",
      () => {
        const buffer = new SkyToolMarkerBuffer();

        buffer.push(
          "```sky-tool",
        );

        expect(buffer.finish()).toEqual({
          mode: "tool",
          textToDisplay: "",
        });
      },
    );

    it(
      "finish() is a no-op once mode already resolved to normal",
      () => {
        const buffer = new SkyToolMarkerBuffer();

        buffer.push(
          "Hello",
        );

        expect(buffer.finish()).toEqual({
          mode: "normal",
          textToDisplay: "",
        });
      },
    );

    it(
      "finish() is a no-op once mode already resolved to tool",
      () => {
        const buffer = new SkyToolMarkerBuffer();

        buffer.push(
          "```sky-tool\n",
        );

        expect(buffer.finish()).toEqual({
          mode: "tool",
          textToDisplay: "",
        });
      },
    );
  },
);
