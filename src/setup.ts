/**
 * Interactive Sky Code setup wizard.
 *
 * Guides a user through configuring an OpenAI-compatible API endpoint, API
 * key, default model, and default permission mode. It verifies connectivity
 * through the endpoint's model-list API and then stores the resulting
 * configuration under ~/.sky-code/.
 *
 * This module is invoked by the Sky Code CLI when the user runs `sky setup`
 * or when first-use setup is required. It deliberately keeps credentials in
 * ~/.sky-code/.env while non-secret settings are stored in config.json.
 */

import inquirer from "inquirer";

import {
  access,
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";

import {
  homedir,
} from "node:os";

import {
  basename,
  dirname,
  join,
} from "node:path";

import {
  DEFAULT_SKY_MD_CONTENT,
} from "./config.js";

/**
 * ANSI-coloured startup banner displayed when SkyCode launches.
 *
 * Uses bright magenta (\x1b[95m) for the tilde arc motif and the "Code"
 * portion of the wordmark, and white (\x1b[97m) for "Sky". The
 * process.stdout.isTTY check prevents ANSI escape codes from being emitted
 * when output is piped or redirected, so non-terminal output receives the
 * plain-text version instead. The reset code (\x1b[0m) returns subsequent
 * terminal text to its normal colour.
 */
const SKYCODE_BANNER = process.stdout.isTTY
  ? '\x1b[95m  ~ ~ ~\x1b[0m\n\x1b[95m ~ ~ ~ ~\x1b[0m\n\x1b[97mSky\x1b[0m\x1b[95mCode\x1b[0m'
  : '  ~ ~ ~\n ~ ~ ~ ~\nSkyCode';

// Default to the conventional local LiteLLM endpoint when the user presses
// Enter without supplying a different OpenAI-compatible API base URL.
const DEFAULT_API_URL =
  "http://localhost:4000/v1";

/**
 * Permission modes offered by the setup wizard.
 *
 * Each entry contains the stored configuration value and the explanatory text
 * displayed to the user during Step 5. The readonly tuple is also used to
 * derive the local PermissionMode union type.
 */
const PERMISSION_MODES = [
  {
    value: "default",
    description:
      "Ask before every file edit and shell command (recommended)",
  },
  {
    value: "auto-accept-edits",
    description:
      "Auto-approve file edits; still ask for shell commands",
  },
  {
    value: "plan",
    description:
      "Describe actions but never execute them",
  },
  {
    value: "bypass",
    description:
      "Execute everything without asking (use with care)",
  },
] as const;

/**
 * Permission-mode values that the setup wizard can store in config.json.
 *
 * The type is derived from PERMISSION_MODES so the displayed choices and the
 * accepted TypeScript values cannot drift apart.
 */
type PermissionMode =
  (typeof PERMISSION_MODES)[number]["value"];

/**
 * Determines whether an unknown value is a non-null, non-array object.
 *
 * Used when validating JSON returned by the model endpoint and when reading an
 * existing config.json file before merging new setup values into it.
 *
 * @param {unknown} value - Value to inspect.
 * @returns {boolean} True when the value can safely be treated as an object
 * with string property names; otherwise false.
 */
function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

/**
 * Checks whether a filesystem path exists.
 *
 * A missing path is reported as false. Other filesystem failures are allowed
 * to propagate because errors such as permission failures should not be
 * mistaken for the file simply not existing.
 *
 * @param {string} filePath - Path to test for accessibility.
 * @returns {Promise<boolean>} True when the path is accessible, or false when
 * it does not exist.
 * @throws {Error} If access fails for a reason other than the path not
 * existing.
 *
 * Side effect: performs a filesystem access check.
 */
async function pathExists(
  filePath: string,
): Promise<boolean> {
  try {
    await access(
      filePath,
    );

    return true;
  } catch (error) {
    const nodeError =
      error as NodeJS.ErrnoException;

    // ENOENT specifically means the path is absent. Other failures, including
    // permissions errors, are important enough to surface to the caller.
    if (
      nodeError.code ===
      "ENOENT"
    ) {
      return false;
    }

    throw error;
  }
}

/**
 * Validates text entered for the API endpoint during the setup prompt.
 *
 * An empty value is accepted because normalizeApiUrl() will substitute the
 * built-in default endpoint. A supplied value must otherwise be an absolute
 * HTTP or HTTPS URL.
 *
 * @param {string} value - Raw URL text entered by the user.
 * @returns {true | string} True when the entry is acceptable, otherwise a
 * human-readable validation message for Inquirer to display.
 */
function validateApiUrl(
  value: string,
): true | string {
  const trimmed =
    value.trim();

  // Empty input means "use the displayed default", so it is a valid answer.
  if (
    trimmed ===
    ""
  ) {
    return true;
  }

  let parsed: URL;

  try {
    parsed =
      new URL(
        trimmed,
      );
  } catch {
    return "Enter a valid absolute URL.";
  }

  if (
    parsed.protocol !==
      "http:" &&
    parsed.protocol !==
      "https:"
  ) {
    return "The URL must use http:// or https://.";
  }

  return true;
}

/**
 * Converts API endpoint input into the canonical base URL stored by setup.
 *
 * Empty input becomes DEFAULT_API_URL. Any trailing slash characters are
 * removed so later path construction does not create duplicate separators.
 *
 * @param {string} value - Raw endpoint text entered by the user.
 * @returns {string} The selected endpoint without trailing slashes.
 */
function normalizeApiUrl(
  value: string,
): string {
  const trimmed =
    value.trim();

  const selected =
    trimmed === ""
      ? DEFAULT_API_URL
      : trimmed;

  return selected.replace(
    /\/+$/,
    "",
  );
}

/**
 * Builds the OpenAI-compatible model-list endpoint from a configured API base
 * URL.
 *
 * If the supplied path already ends in /v1, only /models is appended.
 * Otherwise /v1/models is appended. Existing query parameters and fragments
 * are removed because they do not belong on the model discovery request.
 *
 * @param {string} apiUrl - Valid absolute API base URL.
 * @returns {string} Absolute URL for the endpoint's model-list API.
 * @throws {TypeError} If apiUrl cannot be parsed as a URL.
 */
function buildModelsUrl(
  apiUrl: string,
): string {
  const parsed =
    new URL(
      apiUrl,
    );

  const currentPath =
    parsed.pathname.replace(
      /\/+$/,
      "",
    );

  // Avoid producing /v1/v1/models when the configured base URL already
  // includes the standard OpenAI-compatible /v1 path.
  if (
    currentPath.endsWith(
      "/v1",
    )
  ) {
    parsed.pathname =
      `${currentPath}/models`;
  } else {
    parsed.pathname =
      `${currentPath}/v1/models`;
  }

  // Model discovery should target the canonical endpoint only, not inherit
  // query parameters or fragments that may have appeared in the base URL.
  parsed.search = "";
  parsed.hash = "";

  return parsed.toString();
}

/**
 * Tests the supplied API credentials and discovers available model IDs.
 *
 * Sends an authenticated GET request to the OpenAI-compatible /v1/models
 * endpoint. The response must contain a data array; malformed entries are
 * ignored, valid model IDs are trimmed, and duplicate IDs are removed.
 *
 * The request can be cancelled either by the setup-wide AbortSignal or by the
 * ten-second timeout created specifically for this network operation.
 *
 * @param {string} apiUrl - Configured OpenAI-compatible API base URL.
 * @param {string} apiKey - API key supplied by the user.
 * @param {AbortSignal} setupSignal - Signal used to cancel setup, including
 * when the user presses Ctrl+C.
 * @returns {Promise<string[]>} Unique, non-empty model IDs advertised by the
 * endpoint.
 * @throws {Error} If the HTTP response is unsuccessful, the returned JSON has
 * an invalid shape, or no valid model IDs are returned.
 * @throws {DOMException} If the request is aborted or exceeds the ten-second
 * timeout.
 *
 * Side effect: performs an authenticated network request.
 */
async function testConnection(
  apiUrl: string,
  apiKey: string,
  setupSignal: AbortSignal,
): Promise<string[]> {
  // Ten seconds prevents setup from hanging indefinitely on an unreachable or
  // non-responsive endpoint.
  const timeoutSignal =
    AbortSignal.timeout(
      10_000,
    );

  // AbortSignal.any() allows either Ctrl+C or the network timeout to cancel
  // the same fetch without separate cancellation plumbing.
  const requestSignal =
    AbortSignal.any([
      setupSignal,
      timeoutSignal,
    ]);

  const response =
    await fetch(
      buildModelsUrl(
        apiUrl,
      ),
      {
        method: "GET",

        headers: {
          Accept:
            "application/json",

          Authorization:
            `Bearer ${apiKey}`,
        },

        signal:
          requestSignal,
      },
    );

  if (
    !response.ok
  ) {
    throw new Error(
      `Model endpoint returned HTTP ${response.status}.`,
    );
  }

  const body: unknown =
    await response.json();

  // OpenAI-compatible model discovery is expected to return an object whose
  // `data` property is an array of model records.
  if (
    !isRecord(body) ||
    !Array.isArray(
      body.data,
    )
  ) {
    throw new Error(
      "Model endpoint returned an invalid response.",
    );
  }

  const models:
    string[] = [];

  for (
    const modelValue of
    body.data
  ) {
    // Ignore malformed individual records rather than rejecting an otherwise
    // useful response containing other valid model entries.
    if (
      !isRecord(
        modelValue,
      )
    ) {
      continue;
    }

    if (
      typeof modelValue.id !==
        "string" ||
      modelValue.id.trim() ===
        ""
    ) {
      continue;
    }

    models.push(
      modelValue.id.trim(),
    );
  }

  // Preserve first-seen ordering while eliminating duplicate model IDs.
  const uniqueModels =
    [...new Set(models)];

  if (
    uniqueModels.length ===
    0
  ) {
    throw new Error(
      "Model endpoint returned an empty model list.",
    );
  }

  return uniqueModels;
}

/**
 * Validates a numbered menu selection entered as text.
 *
 * Empty input is accepted because callers use it to select their default
 * option. Non-empty input must contain digits only and represent a number
 * between one and the supplied maximum, inclusive.
 *
 * @param {string} value - Raw selection entered by the user.
 * @param {number} maximum - Highest numbered option allowed.
 * @returns {true | string} True for a valid or defaultable selection,
 * otherwise an Inquirer validation message.
 */
function validateNumberSelection(
  value: string,
  maximum: number,
): true | string {
  const trimmed =
    value.trim();

  // Callers interpret blank input as their documented default selection.
  if (
    trimmed ===
    ""
  ) {
    return true;
  }

  if (
    !/^[0-9]+$/.test(
      trimmed,
    )
  ) {
    return `Enter a number from 1 to ${maximum}.`;
  }

  const selection =
    Number(
      trimmed,
    );

  if (
    selection < 1 ||
    selection > maximum
  ) {
    return `Enter a number from 1 to ${maximum}.`;
  }

  return true;
}

/**
 * Runs Step 1 of setup and asks the user for the AI API endpoint.
 *
 * The displayed local LiteLLM URL is used when the user submits an empty
 * response. Supplied endpoints are validated before the prompt completes and
 * normalized before being returned.
 *
 * @returns {Promise<string>} The normalized API base URL selected by the user.
 *
 * Side effect: writes setup instructions to stdout and waits for interactive
 * terminal input through Inquirer.
 */
async function promptForEndpoint():
  Promise<string> {
  console.log();
  console.log(
    "Step 1 of 6 — API Endpoint",
  );

  console.log(
    "Where is your AI endpoint? (LiteLLM, Ollama, OpenAI, or any OpenAI-compatible server)",
  );

  const answer =
    await inquirer.prompt<{
      apiUrl: string;
    }>([
      {
        type: "input",
        name: "apiUrl",
        message:
          `Base URL [${DEFAULT_API_URL}]`,
        validate:
          validateApiUrl,
      },
    ]);

  return normalizeApiUrl(
    answer.apiUrl,
  );
}

/**
 * Runs Step 2 of setup and securely prompts for the API key.
 *
 * Inquirer masks the value while it is typed. Blank or whitespace-only keys
 * are rejected, and surrounding whitespace is removed before returning.
 *
 * @returns {Promise<string>} The non-empty API key supplied by the user.
 *
 * Side effect: writes to the terminal and waits for hidden interactive input.
 */
async function promptForApiKey():
  Promise<string> {
  console.log();
  console.log(
    "Step 2 of 6 — API Key",
  );

  const answer =
    await inquirer.prompt<{
      apiKey: string;
    }>([
      {
        type: "password",
        name: "apiKey",
        message:
          "Enter your API key (input is hidden)",
        mask: "*",

        validate:
          (
            value: string,
          ) => {
            if (
              value.trim() ===
              ""
            ) {
              return "API key cannot be empty.";
            }

            return true;
          },
      },
    ]);

  return answer.apiKey.trim();
}

/**
 * Asks what setup should do after an API connection test fails.
 *
 * The user may retry with different endpoint information, continue without a
 * discovered model list, or exit setup. Pressing Enter selects retry.
 *
 * @returns {Promise<"retry" | "skip" | "exit">} Symbolic action selected by
 * the user.
 * @throws {Error} If an unexpected selection reaches the switch despite the
 * prompt validation.
 *
 * Side effect: prints choices and waits for interactive terminal input.
 */
async function promptForFailureAction():
  Promise<
    "retry" |
    "skip" |
    "exit"
  > {
  console.log(
    "  1. Try a different URL",
  );

  console.log(
    "  2. Skip this check and continue anyway",
  );

  console.log(
    "  3. Exit setup",
  );

  const answer =
    await inquirer.prompt<{
      action: string;
    }>([
      {
        type: "input",
        name: "action",
        message:
          "Select an option",

        validate:
          (
            value: string,
          ) =>
            validateNumberSelection(
              value,
              3,
            ),
      },
    ]);

  // Blank input defaults to option 1, matching the retry-first recovery path.
  const selected =
    answer.action.trim() ===
      ""
      ? 1
      : Number(
          answer.action.trim(),
        );

  switch (
    selected
  ) {
    case 1:
      return "retry";

    case 2:
      return "skip";

    case 3:
      return "exit";

    default:
      // Prompt validation should make this unreachable during normal use, but
      // retaining the guard protects against unexpected prompt behaviour.
      throw new Error(
        "Invalid setup action.",
      );
  }
}

/**
 * Runs Step 4 and obtains the default AI model.
 *
 * When the connection test returned models, they are shown as a numbered list
 * and the first model is selected by pressing Enter. When connection testing
 * was skipped and the list is empty, the user instead enters a model name
 * manually.
 *
 * @param {string[]} models - Model IDs discovered from the API endpoint, or
 * an empty array when discovery was skipped.
 * @returns {Promise<string>} Model ID selected or manually entered by the
 * user.
 * @throws {Error} If an invalid numbered selection unexpectedly survives
 * prompt validation.
 *
 * Side effect: prints model choices and waits for interactive terminal input.
 */
async function promptForModel(
  models: string[],
): Promise<string> {
  console.log();
  console.log(
    "Step 4 of 6 — Default Model",
  );

  // Skipping the connection test leaves no server-provided choices, so setup
  // falls back to accepting an explicit model identifier from the user.
  if (
    models.length ===
    0
  ) {
    const answer =
      await inquirer.prompt<{
        model: string;
      }>([
        {
          type: "input",
          name: "model",
          message:
            "Enter the model name",

          validate:
            (
              value: string,
            ) => {
              if (
                value.trim() ===
                ""
              ) {
                return "Model name cannot be empty.";
              }

              return true;
            },
        },
      ]);

    return answer.model.trim();
  }

  models.forEach(
    (
      model,
      index,
    ) => {
      console.log(
        `  ${index + 1}. ${model}`,
      );
    },
  );

  const answer =
    await inquirer.prompt<{
      selection: string;
    }>([
      {
        type: "input",
        name: "selection",
        message:
          "Select a model [1]",

        validate:
          (
            value: string,
          ) =>
            validateNumberSelection(
              value,
              models.length,
            ),
      },
    ]);

  // Blank input deliberately maps to array index zero, corresponding to the
  // "[1]" default shown in the prompt.
  const selectedIndex =
    answer.selection.trim() ===
      ""
      ? 0
      : Number(
          answer.selection.trim(),
        ) - 1;

  const selectedModel =
    models[
      selectedIndex
    ];

  if (
    !selectedModel
  ) {
    throw new Error(
      "Invalid model selection.",
    );
  }

  return selectedModel;
}

/**
 * Runs Step 5 and asks the user to choose Sky Code's default permission mode.
 *
 * All available modes and their descriptions are printed before accepting a
 * numbered selection. Pressing Enter chooses the first, recommended mode.
 *
 * @returns {Promise<PermissionMode>} Permission-mode value selected by the
 * user.
 * @throws {Error} If an invalid numbered selection unexpectedly survives
 * prompt validation.
 *
 * Side effect: prints permission choices and waits for interactive input.
 */
async function promptForPermissionMode():
  Promise<PermissionMode> {
  console.log();
  console.log(
    "Step 5 of 6 — Permission Mode",
  );

  PERMISSION_MODES.forEach(
    (
      mode,
      index,
    ) => {
      console.log(
        `  ${index + 1}. ${mode.value.padEnd(17)} — ${mode.description}`,
      );
    },
  );

  const answer =
    await inquirer.prompt<{
      selection: string;
    }>([
      {
        type: "input",
        name: "selection",
        message:
          "Select a mode [1]",

        validate:
          (
            value: string,
          ) =>
            validateNumberSelection(
              value,
              PERMISSION_MODES.length,
            ),
      },
    ]);

  // Blank input selects the first permission mode, matching "[1]" in the
  // prompt and preserving the recommended default behaviour.
  const selectedIndex =
    answer.selection.trim() ===
      ""
      ? 0
      : Number(
          answer.selection.trim(),
        ) - 1;

  const selectedMode =
    PERMISSION_MODES[
      selectedIndex
    ]?.value;

  if (
    !selectedMode
  ) {
    throw new Error(
      "Invalid permission mode selection.",
    );
  }

  return selectedMode;
}

/**
 * Reads an existing Sky Code config.json before reconfiguration.
 *
 * Reconfiguration preserves settings that this wizard does not manage by
 * merging the newly selected values over this existing object later in the
 * process.
 *
 * @param {string} configPath - Path of the existing config.json file.
 * @returns {Promise<Record<string, unknown>>} Parsed configuration object.
 * @throws {Error} If the file cannot be read or parsed, or if its top-level
 * JSON value is not an object.
 *
 * Side effect: reads the configuration file from disk.
 */
async function readExistingConfig(
  configPath: string,
): Promise<
  Record<string, unknown>
> {
  const contents =
    await readFile(
      configPath,
      "utf8",
    );

  const parsed: unknown =
    JSON.parse(
      contents,
    );

  // Object merging below requires a key/value configuration object rather
  // than a primitive, null, or array JSON value.
  if (
    !isRecord(
      parsed,
    )
  ) {
    throw new Error(
      `Existing configuration ${configPath} must contain a JSON object.`,
    );
  }

  return parsed;
}

/**
 * Writes a complete file through a temporary sibling file and then renames it
 * over the destination.
 *
 * Creating the temporary file in the destination directory allows rename() to
 * perform the final replacement atomically on the same filesystem. The target
 * permissions are applied both before and after the rename so the completed
 * file has the requested mode.
 *
 * If any operation fails, the function makes a best-effort attempt to remove
 * the temporary file and then rethrows the original failure.
 *
 * @param {string} filePath - Final destination path.
 * @param {string} contents - Complete UTF-8 contents to write.
 * @param {number} mode - POSIX permission bits to apply to the file.
 * @returns {Promise<void>} Resolves after the destination has been replaced
 * and its permissions applied.
 * @throws {Error} If writing, changing permissions, or renaming fails.
 *
 * Side effects: creates and renames a temporary file, overwrites the target
 * path atomically, changes file permissions, and may delete a temporary file
 * during error recovery.
 */
async function writeFileAtomically(
  filePath: string,
  contents: string,
  mode: number,
): Promise<void> {
  const directory =
    dirname(
      filePath,
    );

  // Include both PID and current time so concurrent or stale setup operations
  // are unlikely to choose the same temporary filename.
  const temporaryPath =
    join(
      directory,
      `.${basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
    );

  try {
    await writeFile(
      temporaryPath,
      contents,
      {
        encoding:
          "utf8",

        mode,
      },
    );

    await chmod(
      temporaryPath,
      mode,
    );

    // The rename is the point at which the fully written temporary file
    // replaces the destination, avoiding a partially written target.
    await rename(
      temporaryPath,
      filePath,
    );

    await chmod(
      filePath,
      mode,
    );
  } catch (error) {
    try {
      await unlink(
        temporaryPath,
      );
    } catch {
      // Cleanup is secondary: if removal also fails, preserve and report the
      // original write/permission/rename error instead.
    }

    throw error;
  }
}

/**
 * Recognizes the error Inquirer uses when an interactive prompt is cancelled.
 *
 * This lets Ctrl+C or other prompt cancellation follow the same friendly
 * setup-cancellation path instead of being reported as an application error.
 *
 * @param {unknown} error - Caught value to inspect.
 * @returns {boolean} True when the value is Inquirer's ExitPromptError.
 */
function isPromptCancellation(
  error: unknown,
): boolean {
  return (
    error instanceof Error &&
    error.name ===
      "ExitPromptError"
  );
}

/**
 * Prints the standard message used when setup ends without completing.
 *
 * @returns {void} This function does not return a value.
 *
 * Side effect: writes the cancellation notice to stdout.
 */
function printCancellationMessage():
  void {
  console.log();
  console.log(
    "Setup cancelled. Run 'sky setup' to try again.",
  );
}

/**
 * Executes the six-step setup workflow using a shared cancellation signal.
 *
 * The wizard optionally confirms reconfiguration, collects endpoint and
 * credential information, tests model discovery, obtains the default model
 * and permission mode, and writes the resulting user-level files.
 *
 * Existing config.json properties are preserved during reconfiguration except
 * for apiUrl, defaultModel, and defaultPermissionMode, which are intentionally
 * replaced with the newly selected values.
 *
 * @param {AbortSignal} setupSignal - Signal that aborts the workflow when
 * setup is cancelled, including through Ctrl+C.
 * @returns {Promise<void>} Resolves when setup completes or when the user
 * chooses not to reconfigure or explicitly exits after a failed connection.
 * @throws {Error} If prompts, network operations, configuration parsing, or
 * filesystem writes fail unexpectedly. Abort-related errors are handled by
 * runSetup().
 *
 * Side effects: prompts in the terminal, performs an API request, creates
 * ~/.sky-code/ when necessary, writes ~/.sky-code/.env and config.json, and
 * seeds ~/.sky-code/sky.md with DEFAULT_SKY_MD_CONTENT when that file does
 * not already exist.
 */
async function runSetupWizard(
  setupSignal: AbortSignal,
): Promise<void> {
  const setupDirectory =
    join(
      homedir(),
      ".sky-code",
    );

  const configPath =
    join(
      setupDirectory,
      "config.json",
    );

  const environmentPath =
    join(
      setupDirectory,
      ".env",
    );

  const skyMdPath =
    join(
      setupDirectory,
      "sky.md",
    );

  const configAlreadyExists =
    await pathExists(
      configPath,
    );

  // Checked independently of configAlreadyExists: sky.md is a freely
  // user-editable file, not tied to whether config.json exists, so a
  // reconfigure of an existing installation must not touch it.
  const skyMdAlreadyExists =
    await pathExists(
      skyMdPath,
    );

  // Check cancellation immediately after the initial asynchronous filesystem
  // operation before opening any interactive prompts.
  setupSignal
    .throwIfAborted();

  if (
    configAlreadyExists
  ) {
    const answer =
      await inquirer.prompt<{
        reconfigure: boolean;
      }>([
        {
          type: "confirm",
          name: "reconfigure",
          message:
            "SkyCode is already configured. Reconfigure?",
          default:
            false,
        },
      ]);

    // Declining reconfiguration intentionally exits without touching any
    // existing setup files.
    if (
      !answer.reconfigure
    ) {
      return;
    }
  }

  console.log();
  console.log(
    SKYCODE_BANNER,
  );

  console.log(
    "─────────────────────────────────────────────────────",
  );

  console.log(
    "This wizard will configure SkyCode for first use.",
  );

  console.log(
    "Press Ctrl+C at any time to exit. Run 'sky setup' again to resume.",
  );

  let apiUrl =
    DEFAULT_API_URL;

  let apiKey =
    "";

  let models:
    string[] = [];

  // Endpoint and key entry repeat together after a failed connection because
  // either value may have caused the failure.
  while (
    true
  ) {
    apiUrl =
      await promptForEndpoint();

    apiKey =
      await promptForApiKey();

    console.log();
    console.log(
      "Step 3 of 6 — Connection Test",
    );

    console.log(
      `Testing connection to ${apiUrl} ...`,
    );

    try {
      models =
        await testConnection(
          apiUrl,
          apiKey,
          setupSignal,
        );

      console.log(
        `✓ Connected. Found ${models.length} ${models.length === 1 ? "model" : "models"}.`,
      );

      break;
    } catch (error) {
      // Cancellation must escape to runSetup() rather than being mistaken for
      // an ordinary connectivity problem and followed by recovery choices.
      if (
        setupSignal.aborted
      ) {
        throw error;
      }

      console.log(
        `✗ Could not connect to ${apiUrl}`,
      );

      console.log(
        "  Check that your endpoint is running and the URL is correct.",
      );

      const action =
        await promptForFailureAction();

      if (
        action ===
        "retry"
      ) {
        continue;
      }

      // Skipping discovery deliberately supplies an empty list so Step 4
      // switches to its manual model-name prompt.
      if (
        action ===
        "skip"
      ) {
        models = [];
        break;
      }

      printCancellationMessage();
      return;
    }
  }

  const defaultModel =
    await promptForModel(
      models,
    );

  const defaultPermissionMode =
    await promptForPermissionMode();

  console.log();
  console.log(
    "Step 6 of 6 — Saving Configuration",
  );

  // Do not begin filesystem changes if cancellation happened during or just
  // after the final prompt.
  setupSignal
    .throwIfAborted();

  await mkdir(
    setupDirectory,
    {
      recursive:
        true,
    },
  );

  // Preserve configuration properties outside the scope of this wizard when
  // reconfiguring an existing installation.
  const existingConfig =
    configAlreadyExists
      ? await readExistingConfig(
          configPath,
        )
      : {};

  // These three properties intentionally override matching values from the
  // existing object with the selections made during this setup run.
  const storedConfig = {
    ...existingConfig,

    apiUrl,

    defaultModel,

    defaultPermissionMode,
  };

  const configContents =
    `${JSON.stringify(
      storedConfig,
      null,
      2,
    )}\n`;

  // Credentials are stored in the environment file rather than config.json.
  // The resulting file is written below with owner-only 0600 permissions.
  const environmentContents = [
    "# Sky Code environment variables",
    "# Generated by sky setup",
    "",
    `LITELLM_API_URL=${apiUrl}`,
    `LITELLM_API_KEY=${apiKey}`,
    "",
  ].join(
    "\n",
  );

  /*
   * Credentials are written first and the non-secret configuration second.
   * Both targets are constructed through temporary files and renamed into
   * place atomically, preventing partially written destination files.
   *
   * The .env receives owner-only 0600 permissions because it contains the API
   * key. config.json receives 0644 because it contains non-secret settings.
   */
  await writeFileAtomically(
    environmentPath,
    environmentContents,
    0o600,
  );

  await writeFileAtomically(
    configPath,
    configContents,
    0o644,
  );

  // Never overwrites an existing sky.md: it is a freely user-editable
  // file, and any customization already made must be preserved. This only
  // seeds a fresh installation that has no sky.md yet.
  if (
    !skyMdAlreadyExists
  ) {
    await writeFileAtomically(
      skyMdPath,
      DEFAULT_SKY_MD_CONTENT,
      0o644,
    );

    console.log(
      "✓ Wrote ~/.sky-code/sky.md",
    );
  }

  console.log(
    "✓ Wrote ~/.sky-code/config.json",
  );

  console.log(
    "✓ Wrote ~/.sky-code/.env",
  );

  console.log();
  console.log(
    "Setup complete. Run 'sky' to start SkyCode.",
  );
}

/**
 * Runs the public Sky Code setup command with Ctrl+C cancellation handling.
 *
 * A temporary SIGINT listener aborts the setup-wide AbortController instead of
 * allowing individual prompts or network requests to manage Ctrl+C
 * independently. Known cancellation cases print a friendly message and return
 * normally; unexpected errors continue to the caller.
 *
 * The SIGINT listener is always removed in the finally block so repeated
 * setup runs in the same process do not accumulate signal handlers.
 *
 * @returns {Promise<void>} Resolves after setup completes or is cancelled.
 * @throws {Error} If setup fails for a reason other than recognized user
 * cancellation.
 *
 * Side effects: installs a temporary process SIGINT listener and runs the
 * interactive setup workflow.
 */
export async function runSetup():
  Promise<void> {
  const setupAbortController =
    new AbortController();

  const handleSigint =
    (): void => {
      setupAbortController
        .abort();
    };

  process.on(
    "SIGINT",
    handleSigint,
  );

  try {
    await runSetupWizard(
      setupAbortController.signal,
    );
  } catch (error) {
    // Both the explicit AbortController path and Inquirer's own cancellation
    // error represent normal user cancellation rather than setup failure.
    if (
      setupAbortController
        .signal
        .aborted ||
      isPromptCancellation(
        error,
      )
    ) {
      printCancellationMessage();
      return;
    }

    throw error;
  } finally {
    // Always remove the process-level listener, including after failures, so
    // this module does not leave persistent signal-handling side effects.
    process.off(
      "SIGINT",
      handleSigint,
    );
  }
}
