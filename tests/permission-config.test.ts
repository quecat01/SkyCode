import {
  describe,
  expect,
  it,
} from "vitest";

import {
  isPermissionMode,
  PERMISSION_MODES,
  validatePermissionMode,
} from "../src/config.ts";

describe(
  "permission mode configuration",
  () => {
    it(
      "defines exactly the four supported permission modes",
      () => {
        expect(
          PERMISSION_MODES,
        ).toEqual([
          "default",
          "auto-accept-edits",
          "plan",
          "bypass",
        ]);
      },
    );

    it(
      "recognizes and validates every supported mode",
      () => {
        for (
          const mode of
          PERMISSION_MODES
        ) {
          expect(
            isPermissionMode(
              mode,
            ),
          ).toBe(true);

          expect(
            validatePermissionMode(
              mode,
            ),
          ).toBe(mode);
        }
      },
    );

    it(
      "rejects unsupported permission modes",
      () => {
        expect(
          isPermissionMode(
            "automatic",
          ),
        ).toBe(false);

        expect(
          isPermissionMode(
            42,
          ),
        ).toBe(false);

        expect(
          () =>
            validatePermissionMode(
              "automatic",
            ),
        ).toThrow(
          'defaultPermissionMode must be one of "default", "auto-accept-edits", "plan", or "bypass"',
        );
      },
    );
  },
);
