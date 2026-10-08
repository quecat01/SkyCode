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
      "defaults every model to native, with an empty override table",
      () => {
        expect(DEFAULT_STRATEGY_KIND).toBe(
          "native",
        );

        expect(
          MODEL_STRATEGY_CONFIG,
        ).toEqual({});
      },
    );

    it(
      "resolves the current Gemma and GPT models to native with no model entries",
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
      "resolves a completely unknown model to native, never to legacy",
      () => {
        for (
          const model of [
            "some-unlisted-model",
            "a-future-model-sky-has-never-seen",
            "chatgpt-gpt-5.5",
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
      "defaults every model to streaming, with an empty override table",
      () => {
        expect(DEFAULT_NATIVE_TRANSPORT).toBe(
          "streaming",
        );

        expect(
          NATIVE_TRANSPORT_CONFIG,
        ).toEqual({});

        for (
          const model of [
            "gemma4-e4b-sky",
            "chatgpt-gpt-5.6-sol",
            "some-unlisted-model",
          ]
        ) {
          expect(
            resolveNativeTransport(
              model,
            ),
          ).toBe(
            "streaming",
          );
        }
      },
    );

    it(
      "still lets an explicit override force a strategy: prompted or legacy",
      () => {
        const overrides: Record<
          string,
          StrategyKind
        > = {
          "needs-prompted": "prompted",
          "needs-legacy": "legacy",
        };

        expect(
          resolveStrategyKind(
            "needs-prompted",
            overrides,
          ),
        ).toBe(
          "prompted",
        );

        expect(
          resolveStrategyKind(
            "needs-legacy",
            overrides,
          ),
        ).toBe(
          "legacy",
        );

        expect(
          resolveStrategyKind(
            "anything-else",
            overrides,
          ),
        ).toBe(
          "native",
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
