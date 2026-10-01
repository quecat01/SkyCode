import {
  describe,
  expect,
  it,
} from "vitest";

import {
  DEFAULT_STRATEGY_KIND,
  MODEL_STRATEGY_CONFIG,
  resolveStrategyKind,
} from "../src/agent/strategy-selection.ts";

import type {
  StrategyKind,
} from "../src/agent/strategy-selection.ts";

describe(
  "agent/strategy-selection.ts",
  () => {
    it(
      "MODEL_STRATEGY_CONFIG contains exactly one evidence-tested entry: gemma4-e4b-sky mapped to prompted, from the real P1-P5 Legacy-vs-Prompted comparison testing",
      () => {
        expect(
          MODEL_STRATEGY_CONFIG,
        ).toEqual(
          {
            "gemma4-e4b-sky":
              "prompted",
          },
        );
      },
    );

    it(
      "resolves gemma4-e4b-sky to PromptedStrategy against the real, non-injected MODEL_STRATEGY_CONFIG",
      () => {
        expect(
          resolveStrategyKind(
            "gemma4-e4b-sky",
          ),
        ).toBe(
          "prompted",
        );
      },
    );

    it(
      "resolves any model with no explicit entry to DEFAULT_STRATEGY_KIND against the real MODEL_STRATEGY_CONFIG, even though it now has one entry",
      () => {
        expect(
          resolveStrategyKind(
            "some-unlisted-model",
          ),
        ).toBe(
          DEFAULT_STRATEGY_KIND,
        );

        expect(
          resolveStrategyKind(
            "another-unlisted-model",
          ),
        ).toBe(
          "legacy",
        );
      },
    );

    it(
      "honors an explicit entry in an injected config",
      () => {
        const fakeConfig: Readonly<
          Record<string, StrategyKind>
        > = {
          "tested-model": "native",
        };

        expect(
          resolveStrategyKind(
            "tested-model",
            fakeConfig,
          ),
        ).toBe(
          "native",
        );
      },
    );

    it(
      "falls back to DEFAULT_STRATEGY_KIND for a model absent from an injected config, even when that config has other entries",
      () => {
        const fakeConfig: Readonly<
          Record<string, StrategyKind>
        > = {
          "tested-model": "native",
        };

        expect(
          resolveStrategyKind(
            "some-other-model",
            fakeConfig,
          ),
        ).toBe(
          DEFAULT_STRATEGY_KIND,
        );
      },
    );

    it(
      "honors an injected config entry for the prompted strategy as well",
      () => {
        const fakeConfig: Readonly<
          Record<string, StrategyKind>
        > = {
          "prompted-model": "prompted",
        };

        expect(
          resolveStrategyKind(
            "prompted-model",
            fakeConfig,
          ),
        ).toBe(
          "prompted",
        );
      },
    );

    it(
      "trims surrounding whitespace from the model name before lookup",
      () => {
        const fakeConfig: Readonly<
          Record<string, StrategyKind>
        > = {
          "tested-model": "native",
        };

        expect(
          resolveStrategyKind(
            "  tested-model  ",
            fakeConfig,
          ),
        ).toBe(
          "native",
        );
      },
    );

    it(
      "does not match a model name against a differently-cased or padded config key (no fuzzy matching)",
      () => {
        const fakeConfig: Readonly<
          Record<string, StrategyKind>
        > = {
          "Tested-Model": "native",
        };

        expect(
          resolveStrategyKind(
            "tested-model",
            fakeConfig,
          ),
        ).toBe(
          DEFAULT_STRATEGY_KIND,
        );
      },
    );
  },
);
