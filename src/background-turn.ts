import type {
  SkyToolRequest,
  ToolExecutionResult,
} from "./tools.js";

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
