/**
 * Turn-flow decision helper for Sky Code background shell commands.
 *
 * This module determines when successful background-command startup should end
 * the current assistant turn and immediately return control to the user prompt
 * instead of continuing normal foreground tool-processing flow.
 */
import type {
  SkyToolRequest,
  ToolExecutionResult,
} from "./tools.js";

/**
 * Determines whether a completed tool request should immediately return control
 * to the interactive prompt.
 *
 * Returning true is intentionally restricted to successful
 * `run_shell_command` requests whose `background` argument is explicitly true.
 * Failed requests, foreground shell commands, and all other tools continue
 * through the normal turn flow.
 *
 * @param {SkyToolRequest} request - Tool request that was executed.
 * @param {ToolExecutionResult} result - Result produced by tool execution.
 * @returns {boolean} True only when a background shell command started
 * successfully and the turn should return to the prompt.
 *
 * Side effects: none.
 */
export function shouldReturnToPromptAfterBackgroundTool(
  request:
    SkyToolRequest,
  result:
    ToolExecutionResult,
): boolean {
  return (
    result.success &&
    request.tool ===
      "run_shell_command" &&
    request.args
      .background ===
      true
  );
}
