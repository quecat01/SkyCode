/**
 * Live ToolExecutor adapter over Sky Code's existing ToolHandlers and
 * HookRegistry.
 *
 * Wraps executeSkyToolRequestWithHooks() (hooks.ts) so runAgentLoop() can run
 * a real tool exactly the way Sky Code's live conversation path already does
 * (permission prompts, hooks, background-tool detection), behind the
 * model/provider-independent ToolExecutor interface (see agent/types.ts).
 * This is the one place a strategy-proposed {tool, arguments} pair is turned
 * into a real, executed side effect.
 *
 * Two things this adapter is deliberately NOT responsible for:
 * - Console status messages and session logging ("Tool completed: ...", a
 *   session log tool_result entry): those belong to runAgentLoop()'s
 *   onEvent listener, driven from the AgentEvent stream the loop already
 *   records (see AgentEventListener in loop.ts), so they stay in sync with
 *   exactly what the loop recorded rather than duplicating that bookkeeping
 *   here.
 * - Permission approval prompting: already fully owned by the ToolHandlers
 *   implementation itself (see toolhandlers.ts's createToolHandlers()),
 *   unchanged by this adapter.
 *
 * What it does own: pausing/resuming the CLI's readline interface (and
 * restoring terminal raw mode afterward) around each individual tool
 * execution, mirroring index.ts's existing per-round handling, since an
 * approval prompt or the tool itself may need the terminal. This has to live
 * here, not in whatever wraps the whole runAgentLoop() call, because
 * executor.execute() is invoked once per tool call within a turn, not once
 * per turn.
 *
 * verified passthrough: ToolExecutionResult.verified (tools.ts) is set by a
 * handler only when it genuinely performed an independent post-condition
 * check (the four document-generation handlers do this today, via their
 * own structural validation in docgen/*.ts; see toolhandlers.ts). This
 * adapter copies that field through to AgentToolResult.verified exactly as
 * reported and never infers it from the tool's name or from `success`
 * alone - a handler that omits the field yields an unverified
 * AgentToolResult, same as before this field existed.
 */
import {
  executeSkyToolRequestWithHooks,
} from "../../hooks.js";

import {
  validateSkyToolRequest,
} from "../../tools.js";

import {
  shouldReturnToPromptAfterBackgroundTool,
} from "../../background-turn.js";

import {
  restoreReadlineRawMode,
} from "../../readline-redraw.js";

import type {
  HookRegistry,
} from "../../hooks.js";

import type {
  ToolHandlers,
} from "../../tools.js";

import type {
  AgentToolResult,
  ToolExecutor,
} from "../types.js";

/**
 * Minimal readline surface this adapter needs: pausing input while a tool
 * (or its approval prompt) may interact with the terminal, then resuming it
 * afterward. Kept as a narrow structural type, rather than importing Node's
 * full readline Interface, so tests can pass a plain fake instead of a real
 * terminal-backed readline interface.
 */
export interface PausableReadline {
  pause(): void;
  resume(): void;
}

/**
 * Creates a ToolExecutor backed by Sky Code's real ToolHandlers and
 * HookRegistry, for use as runAgentLoop()'s executor in the live CLI.
 *
 * @param {ToolHandlers} handlers - Tool implementations available this
 * session.
 * @param {HookRegistry} hookRegistry - Hooks wrapped around tool execution
 * (see executeSkyToolRequestWithHooks in hooks.ts).
 * @param {PausableReadline} readline - CLI readline interface to pause while
 * a tool (or its approval prompt) may interact with the terminal, and
 * resume afterward.
 * @param {unknown} rawModeInput - Input stream passed to
 * restoreReadlineRawMode() after each execution; accepts the same loosely
 * typed value restoreReadlineRawMode() itself accepts (in production,
 * process.stdin).
 * @returns {ToolExecutor} Executor that runs a real Sky Code tool for every
 * call.
 */
export function createLiveToolExecutor(
  handlers: ToolHandlers,
  hookRegistry: HookRegistry,
  readline: PausableReadline,
  rawModeInput: unknown,
): ToolExecutor {
  return {
    async execute(
      tool,
      args,
    ): Promise<AgentToolResult> {
      // Defensive re-validation: NativeStrategy and PromptedStrategy already
      // validate before ever forming a tool_call AgentAction (see
      // agent/strategies/native.ts and prompted.ts), and LegacyStrategy's
      // underlying analyzeSkyToolResponse() validates too, so this should
      // never actually fail in practice. It runs anyway because this
      // boundary is where a real side effect happens, so it never trusts an
      // upstream invariant blindly (see validateSkyToolRequest's own doc
      // comment in tools.ts).
      let request;

      try {
        request =
          validateSkyToolRequest(
            tool,
            args,
          );
      } catch (error) {
        return {
          success: false,
          output:
            error instanceof Error
              ? error.message
              : String(error),
        };
      }

      // Readline is paused while the tool (or its approval prompt) may
      // itself interact with the terminal; this avoids competing reads and
      // prompt redraw problems, mirroring index.ts's existing per-round
      // handling. Always resumed, and raw mode always restored, even if
      // execution throws.
      readline.pause();

      let result;

      try {
        result =
          await executeSkyToolRequestWithHooks(
            request,
            handlers,
            hookRegistry,
          );
      } finally {
        readline.resume();

        restoreReadlineRawMode(
          rawModeInput,
        );
      }

      const endsTurn =
        shouldReturnToPromptAfterBackgroundTool(
          request,
          result,
        );

      const toolResult: AgentToolResult = {
        success: result.success,
        output: result.output,
      };

      // Passed through exactly as the handler reported it - never inferred
      // from `tool`, `request.tool`, or anything else here. A handler that
      // omitted the field (the common case) leaves this adapter's result
      // with verified omitted too.
      if (result.verified === true) {
        toolResult.verified = true;
      }

      if (endsTurn) {
        toolResult.endsTurn = true;
      }

      return toolResult;
    },
  };
}
