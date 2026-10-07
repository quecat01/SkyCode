import {
  describe,
  expect,
  it,
} from "vitest";

import {
  DEFAULT_NATIVE_TRANSPORT,
  DEFAULT_STRATEGY_KIND,
  MODEL_STRATEGY_CONFIG,
  NATIVE_TRANSPORT_CONFIG,
  resolveNativeTransport,
  resolveStrategyKind,
} from "../src/agent/strategy-selection.ts";

import type {
  NativeTransport,
  StrategyKind,
} from "../src/agent/strategy-selection.ts";

describe(
  "agent/strategy-selection.ts",
  () => {
    it(
      "MODEL_STRATEGY_CONFIG contains exactly the three models evidence-tested on a native tool-calling path, all mapped to native",
      () => {
        expect(
          MODEL_STRATEGY_CONFIG,
        ).toEqual(
          {
            "gemma4-e2b-sky":
              "native",
            "gemma4-e4b-sky":
              "native",
            "chatgpt-gpt-5.6-sol":
              "native",
          },
        );
      },
    );

    it(
      "resolves each configured model to NativeStrategy against the real, non-injected MODEL_STRATEGY_CONFIG",
      () => {
        for (
          const model of [
            "gemma4-e2b-sky",
            "gemma4-e4b-sky",
            "chatgpt-gpt-5.6-sol",
          ]
        ) {
          expect(
            resolveStrategyKind(
              model,
            ),
          ).toBe(
            "native",
          );
        }
      },
    );

    it(
      "resolves any model with no explicit entry to DEFAULT_STRATEGY_KIND against the real MODEL_STRATEGY_CONFIG, even though it now has entries",
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

describe(
  "agent/strategy-selection.ts native transport",
  () => {
    it(
      "streams native requests for exactly the three native models",
      () => {
        expect(
          NATIVE_TRANSPORT_CONFIG,
        ).toEqual({
          "gemma4-e2b-sky": "streaming",
          "gemma4-e4b-sky": "streaming",
          "chatgpt-gpt-5.6-sol": "streaming",
        });
      },
    );

    it(
      "keeps the non-streaming request as the default for every other model",
      () => {
        expect(DEFAULT_NATIVE_TRANSPORT).toBe(
          "non_streaming",
        );

        expect(
          resolveNativeTransport(
            "some-unlisted-model",
          ),
        ).toBe(
          "non_streaming",
        );
      },
    );

    it(
      "lets a model fall back to non-streaming through config alone",
      () => {
        const fallbackConfig: Record<
          string,
          NativeTransport
        > = {
          "gemma4-e4b-sky": "non_streaming",
        };

        expect(
          resolveNativeTransport(
            "gemma4-e4b-sky",
            fallbackConfig,
          ),
        ).toBe(
          "non_streaming",
        );

        expect(
          resolveNativeTransport(
            "  gemma4-e2b-sky  ",
          ),
        ).toBe(
          "streaming",
        );
      },
    );

    it(
      "keeps PromptedStrategy and LegacyStrategy selectable per model through config",
      () => {
        const config: Record<
          string,
          StrategyKind
        > = {
          "gemma4-e4b-sky": "prompted",
          "old-model": "legacy",
        };

        expect(
          resolveStrategyKind(
            "gemma4-e4b-sky",
            config,
          ),
        ).toBe(
          "prompted",
        );

        expect(
          resolveStrategyKind(
            "old-model",
            config,
          ),
        ).toBe(
          "legacy",
        );
      },
    );
  },
);
