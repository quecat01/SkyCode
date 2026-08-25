/**
 * Application configuration module.
 *
 * Responsible for loading Sky Code configuration from built-in defaults,
 * user-level configuration, project-level configuration, and environment
 * variables. It also validates permission settings, compaction settings,
 * plugin directories, and Model Context Protocol (MCP) server definitions
 * before the rest of the application receives them.
 *
 * Other Sky Code modules depend on the validated AppConfig returned by
 * loadConfig() rather than reading configuration files directly.
 */

import { config as loadDotEnv } from "dotenv";

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Permission modes accepted by Sky Code configuration.
 *
 * The readonly tuple is also used to derive the PermissionMode union type
 * and to validate configuration values at runtime.
 */
export const PERMISSION_MODES = [
  "default",
  "auto-accept-edits",
  "plan",
  "bypass",
] as const;

/**
 * A valid Sky Code permission mode.
 *
 * The available values are derived directly from PERMISSION_MODES so the
 * runtime list and TypeScript type remain synchronized.
 */
export type PermissionMode =
  (typeof PERMISSION_MODES)[number];

/**
 * Conversation compaction strategies accepted by Sky Code configuration.
 *
 * The readonly tuple is also used to derive the CompactionStrategy type
 * and to validate configuration values at runtime.
 */
export const COMPACTION_STRATEGIES = [
  "summarise",
  "sliding-window",
] as const;

/**
 * A valid strategy for reducing conversation context when compaction occurs.
 *
 * The available values are derived directly from COMPACTION_STRATEGIES.
 */
export type CompactionStrategy =
  (typeof COMPACTION_STRATEGIES)[number];

/**
 * Transport mechanisms supported for Model Context Protocol (MCP) servers.
 *
 * "stdio" connects to a locally spawned process, "sse" uses Server-Sent
 * Events over HTTP, and "http" uses the Streamable HTTP transport.
 */
export type McpTransport =
  | "stdio"
  | "sse"
  | "http";

/**
 * Configuration for an MCP server that Sky Code starts as a local process
 * and communicates with through standard input and standard output.
 */
export interface StdioMcpServerConfig {
  /** Human-readable server name, which must be unique within mcpServers. */
  name: string;
  /** Discriminator identifying this configuration as a stdio transport. */
  transport: "stdio";
  /** Executable command used to start the MCP server process. */
  command: string;
  /** Command-line arguments passed to the MCP server process. */
  args: string[];
  /** Optional environment variables supplied to the spawned process. */
  env?: Record<string, string>;
  /** Optional working directory in which the MCP server process is started. */
  cwd?: string;
}

/**
 * Configuration for an MCP server reached through Server-Sent Events (SSE).
 */
export interface SseMcpServerConfig {
  /** Human-readable server name, which must be unique within mcpServers. */
  name: string;
  /** Discriminator identifying this configuration as an SSE transport. */
  transport: "sse";
  /** Absolute http:// or https:// URL of the SSE MCP endpoint. */
  url: string;
  /** Optional HTTP headers sent when connecting to the server. */
  headers?: Record<string, string>;
}

/**
 * Configuration for an MCP server reached through the Streamable HTTP
 * transport.
 */
export interface HttpMcpServerConfig {
  /** Human-readable server name, which must be unique within mcpServers. */
  name: string;
  /** Discriminator identifying this configuration as Streamable HTTP. */
  transport: "http";
  /** Absolute http:// or https:// URL of the Streamable HTTP MCP endpoint. */
  url: string;
  /** Optional HTTP headers sent when connecting to the server. */
  headers?: Record<string, string>;
}

/**
 * A validated MCP server configuration.
 *
 * The transport field acts as the discriminator that determines which
 * transport-specific fields are available.
 */
export type McpServerConfig =
  | StdioMcpServerConfig
  | SseMcpServerConfig
  | HttpMcpServerConfig;

/**
 * Raw configuration shape accepted from JSON configuration files.
 *
 * Fields that require runtime validation remain typed as unknown here.
 * This prevents untrusted JSON values from being treated as valid application
 * configuration before their dedicated validation functions have checked them.
 */
export interface StoredConfig {
  /** Optional API endpoint supplied by a JSON configuration file. */
  apiUrl?: string;
  /** Optional default model supplied by a JSON configuration file. */
  defaultModel?: string;
  /** Optional default permission mode supplied by a JSON configuration file. */
  defaultPermissionMode?: PermissionMode;
  /** Raw compaction threshold value; validated before use. */
  compactionThreshold?: unknown;
  /** Raw compaction strategy value; validated before use. */
  compactionStrategy?: unknown;
  /** Raw sliding-window size value; validated before use. */
  compactionWindowSize?: unknown;
  /** Raw MCP server list; validated before use. */
  mcpServers?: unknown;
  /** Raw plugin-directory list; validated before use. */
  pluginDirs?: unknown;
}

/**
 * Fully validated runtime configuration used by Sky Code.
 *
 * Unlike StoredConfig, every field is required and has passed the validation
 * necessary for the application to use it safely.
 */
export interface AppConfig {
  /** Base URL of the configured OpenAI-compatible API endpoint. */
  apiUrl: string;
  /** API key read from the LITELLM_API_KEY environment variable. */
  apiKey: string;
  /** Model Sky Code selects by default. */
  defaultModel: string;
  /** Permission policy Sky Code uses by default. */
  defaultPermissionMode: PermissionMode;
  /** Positive whole-number threshold that controls conversation compaction. */
  compactionThreshold: number;
  /** Strategy used when conversation compaction occurs. */
  compactionStrategy: CompactionStrategy;
  /** Positive whole-number window size used by sliding-window compaction. */
  compactionWindowSize: number;
  /** Validated MCP server definitions available to the application. */
  mcpServers: McpServerConfig[];
  /** Validated additional directories from which plugins may be loaded. */
  pluginDirs: string[];
}

// Resolve the repository-level .env relative to this module rather than the
// caller's working directory, so starting Sky Code elsewhere does not change
// which project environment file this module attempts to load.
const environmentPath =
  fileURLToPath(
    new URL(
      "../.env",
      import.meta.url,
    ),
  );

// Load the repository-level environment before reading runtime configuration.
loadDotEnv({
  path: environmentPath,
  quiet: true,
});

// User-level setup stores credentials in ~/.sky-code/.env, allowing an
// installed Sky Code command to obtain configuration independently of a
// particular project's working directory.
const globalEnvironmentPath =
  join(
    homedir(),
    ".sky-code",
    ".env",
  );

loadDotEnv({
  path: globalEnvironmentPath,
  quiet: true,
});

// Built-in defaults live with the application rather than in the caller's
// current directory, so they are resolved relative to this module as well.
const defaultsPath =
  fileURLToPath(
    new URL(
      "../config/defaults.json",
      import.meta.url,
    ),
  );

/**
 * Determines whether an unknown value is a plain non-array object suitable
 * for property-based configuration validation.
 *
 * @param {unknown} value - The value to inspect.
 * @returns {boolean} True when the value is a non-null object and not an
 * array; otherwise false.
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
 * Reads and parses one JSON configuration file.
 *
 * A missing file is treated as an empty configuration so that global and
 * project configuration files remain optional. Other filesystem errors,
 * malformed JSON, and JSON whose root value is not an object are reported
 * as configuration-loading errors.
 *
 * @param {string} path - Absolute or resolved path of the JSON file to read.
 * @returns {Promise<StoredConfig>} The parsed configuration object, or an
 * empty object when the file does not exist.
 * @throws {Error} If the file exists but cannot be read, contains invalid
 * JSON, or contains a top-level value other than a JSON object.
 *
 * Side effect: reads the specified file from the filesystem.
 */
async function readConfigFile(
  path: string,
): Promise<StoredConfig> {
  try {
    const contents =
      await readFile(
        path,
        "utf8",
      );

    const parsed: unknown =
      JSON.parse(contents);

    // Configuration merging relies on named object properties, so arrays,
    // null, and primitive JSON values are rejected even though they are valid
    // JSON documents.
    if (!isRecord(parsed)) {
      throw new Error(
        "configuration must contain a JSON object",
      );
    }

    return parsed;
  } catch (error) {
    const nodeError =
      error as NodeJS.ErrnoException;

    // Not having a configuration file at a particular precedence level is
    // valid. The other available configuration sources can still be used.
    if (
      nodeError.code ===
      "ENOENT"
    ) {
      return {};
    }

    // Include the source path in the wrapped error so a user can identify
    // which of the possible configuration files caused startup to fail.
    throw new Error(
      `Unable to load configuration file ${path}: ${
        error instanceof Error
          ? error.message
          : String(error)
      }`,
    );
  }
}

/**
 * Validates that a configuration value is a string containing at least one
 * non-whitespace character, then returns its trimmed form.
 *
 * @param {unknown} value - The untrusted value to validate.
 * @param {string} name - Configuration field name used in validation errors.
 * @returns {string} The validated string with surrounding whitespace removed.
 * @throws {Error} If the value is not a string or contains only whitespace.
 */
function requireNonEmptyString(
  value: unknown,
  name: string,
): string {
  if (
    typeof value !== "string" ||
    value.trim() === ""
  ) {
    throw new Error(
      `${name} must be a non-empty string`,
    );
  }

  return value.trim();
}

/**
 * Validates an optional string configuration value.
 *
 * Undefined means that the optional field was not configured. Any supplied
 * value must satisfy the same non-empty-string rules used for required
 * string fields.
 *
 * @param {unknown} value - The optional untrusted value to validate.
 * @param {string} name - Configuration field name used in validation errors.
 * @returns {string | undefined} A trimmed non-empty string when supplied,
 * otherwise undefined.
 * @throws {Error} If a supplied value is not a non-empty string.
 */
function validateOptionalString(
  value: unknown,
  name: string,
): string | undefined {
  if (
    value === undefined
  ) {
    return undefined;
  }

  return requireNonEmptyString(
    value,
    name,
  );
}

/**
 * Validates a configuration value as an array whose elements are strings.
 *
 * Undefined is treated as an empty array. String contents are deliberately
 * returned unchanged; unlike validateNonEmptyStringArray(), this validator
 * only checks the element type.
 *
 * @param {unknown} value - The untrusted value to validate.
 * @param {string} name - Configuration field name used in validation errors.
 * @returns {string[]} The validated string array, or an empty array when the
 * value is undefined.
 * @throws {Error} If the value is not an array or any element is not a string.
 */
function validateStringArray(
  value: unknown,
  name: string,
): string[] {
  if (
    value === undefined
  ) {
    return [];
  }

  if (
    !Array.isArray(value)
  ) {
    throw new Error(
      `${name} must be an array of strings`,
    );
  }

  return value.map(
    (
      item: unknown,
      index: number,
    ): string => {
      if (
        typeof item !==
        "string"
      ) {
        throw new Error(
          `${name}[${index}] must be a string`,
        );
      }

      return item;
    },
  );
}

/**
 * Validates a configuration value as an array of non-empty strings.
 *
 * Undefined is treated as an empty array. Each supplied string is trimmed
 * before being returned so whitespace surrounding configured paths does not
 * become part of the resulting value.
 *
 * @param {unknown} value - The untrusted value to validate.
 * @param {string} name - Configuration field name used in validation errors.
 * @returns {string[]} The validated and trimmed string array, or an empty
 * array when the value is undefined.
 * @throws {Error} If the value is not an array or any element is not a
 * non-empty string.
 */
function validateNonEmptyStringArray(
  value: unknown,
  name: string,
): string[] {
  if (
    value === undefined
  ) {
    return [];
  }

  if (
    !Array.isArray(value)
  ) {
    throw new Error(
      `${name} must be an array of non-empty strings`,
    );
  }

  return value.map(
    (
      item: unknown,
      index: number,
    ): string => {
      if (
        typeof item !==
          "string" ||
        item.trim() === ""
      ) {
        throw new Error(
          `${name}[${index}] must be a non-empty string`,
        );
      }

      return item.trim();
    },
  );
}

/**
 * Validates an optional object whose property values must all be strings.
 *
 * This is used for MCP environment-variable maps and HTTP header maps.
 * Undefined remains undefined so callers can distinguish an omitted property
 * from an explicitly supplied object.
 *
 * @param {unknown} value - The untrusted value to validate.
 * @param {string} name - Configuration field name used in validation errors.
 * @returns {Record<string, string> | undefined} A string-valued object when
 * supplied, otherwise undefined.
 * @throws {Error} If the value is not an object, contains an empty property
 * name, or contains a non-string property value.
 */
function validateStringRecord(
  value: unknown,
  name: string,
): Record<string, string> | undefined {
  if (
    value === undefined
  ) {
    return undefined;
  }

  if (!isRecord(value)) {
    throw new Error(
      `${name} must be an object containing string values`,
    );
  }

  const validatedEntries =
    Object.entries(value).map(
      (
        [
          key,
          entryValue,
        ],
      ) => {
        // Empty property names would create ambiguous environment-variable
        // or header entries, so they are rejected before reconstructing the
        // validated object.
        if (
          key.trim() === ""
        ) {
          throw new Error(
            `${name} contains an empty key`,
          );
        }

        if (
          typeof entryValue !==
          "string"
        ) {
          throw new Error(
            `${name}.${key} must be a string`,
          );
        }

        return [
          key,
          entryValue,
        ] as const;
      },
    );

  return Object.fromEntries(
    validatedEntries,
  );
}

/**
 * Validates an MCP network endpoint as an absolute HTTP or HTTPS URL.
 *
 * WebSocket URLs receive a specific error because the configured MCP network
 * transports in this module expect HTTP-based endpoints instead.
 *
 * @param {unknown} value - The untrusted URL value to validate.
 * @param {string} name - Configuration field name used in validation errors.
 * @param {string} transportLabel - Human-readable transport name included in
 * the WebSocket-specific error message.
 * @returns {string} The validated URL text.
 * @throws {Error} If the value is empty, is not an absolute URL, uses a
 * WebSocket URL, or uses a protocol other than HTTP or HTTPS.
 */
function validateHttpUrl(
  value: unknown,
  name: string,
  transportLabel: string,
): string {
  const urlText =
    requireNonEmptyString(
      value,
      name,
    );

  let parsedUrl: URL;

  try {
    parsedUrl =
      new URL(urlText);
  } catch {
    throw new Error(
      `${name} must be a valid absolute URL`,
    );
  }

  // WebSocket URLs are valid URLs syntactically, but they are not supported
  // by either of the HTTP-based MCP transports represented here.
  if (
    parsedUrl.protocol ===
      "ws:" ||
    parsedUrl.protocol ===
      "wss:"
  ) {
    throw new Error(
      `${name} does not support WebSocket URLs. Use an http:// or https:// ${transportLabel} endpoint.`,
    );
  }

  if (
    parsedUrl.protocol !==
      "http:" &&
    parsedUrl.protocol !==
      "https:"
  ) {
    throw new Error(
      `${name} must use http:// or https://`,
    );
  }

  return urlText;
}

/**
 * Validates the transport-specific fields of a stdio MCP server definition
 * and constructs its normalized StdioMcpServerConfig.
 *
 * @param {Record<string, unknown>} serverValue - Raw MCP server object.
 * @param {string} fieldName - Indexed configuration path used in errors.
 * @param {string} name - Already validated unique server name.
 * @returns {StdioMcpServerConfig} The validated stdio server configuration.
 * @throws {Error} If command, arguments, working directory, or environment
 * values do not satisfy their required formats.
 */
function validateStdioServer(
  serverValue:
    Record<string, unknown>,
  fieldName: string,
  name: string,
): StdioMcpServerConfig {
  const command =
    requireNonEmptyString(
      serverValue.command,
      `${fieldName}.command`,
    );

  const args =
    validateStringArray(
      serverValue.args,
      `${fieldName}.args`,
    );

  const cwd =
    validateOptionalString(
      serverValue.cwd,
      `${fieldName}.cwd`,
    );

  const env =
    validateStringRecord(
      serverValue.env,
      `${fieldName}.env`,
    );

  return {
    name,
    transport: "stdio",
    command,
    args,
    // Preserve optional fields as genuinely absent properties when they were
    // not configured instead of emitting properties whose values are undefined.
    ...(cwd === undefined
      ? {}
      : {
          cwd,
        }),
    ...(env === undefined
      ? {}
      : {
          env,
        }),
  };
}

/**
 * Validates the transport-specific fields of an SSE MCP server definition
 * and constructs its normalized SseMcpServerConfig.
 *
 * @param {Record<string, unknown>} serverValue - Raw MCP server object.
 * @param {string} fieldName - Indexed configuration path used in errors.
 * @param {string} name - Already validated unique server name.
 * @returns {SseMcpServerConfig} The validated SSE server configuration.
 * @throws {Error} If the URL or optional HTTP headers are invalid.
 */
function validateSseServer(
  serverValue:
    Record<string, unknown>,
  fieldName: string,
  name: string,
): SseMcpServerConfig {
  const url =
    validateHttpUrl(
      serverValue.url,
      `${fieldName}.url`,
      "SSE",
    );

  const headers =
    validateStringRecord(
      serverValue.headers,
      `${fieldName}.headers`,
    );

  return {
    name,
    transport: "sse",
    url,
    // Do not add a headers property when none was configured.
    ...(headers === undefined
      ? {}
      : {
          headers,
        }),
  };
}

/**
 * Validates the transport-specific fields of a Streamable HTTP MCP server
 * definition and constructs its normalized HttpMcpServerConfig.
 *
 * @param {Record<string, unknown>} serverValue - Raw MCP server object.
 * @param {string} fieldName - Indexed configuration path used in errors.
 * @param {string} name - Already validated unique server name.
 * @returns {HttpMcpServerConfig} The validated HTTP server configuration.
 * @throws {Error} If the URL or optional HTTP headers are invalid.
 */
function validateHttpServer(
  serverValue:
    Record<string, unknown>,
  fieldName: string,
  name: string,
): HttpMcpServerConfig {
  const url =
    validateHttpUrl(
      serverValue.url,
      `${fieldName}.url`,
      "Streamable HTTP",
    );

  const headers =
    validateStringRecord(
      serverValue.headers,
      `${fieldName}.headers`,
    );

  return {
    name,
    transport: "http",
    url,
    // Do not add a headers property when none was configured.
    ...(headers === undefined
      ? {}
      : {
          headers,
        }),
  };
}

/**
 * Validates the complete mcpServers configuration value.
 *
 * Every entry must be an object with a non-empty, unique name and one of the
 * supported transport values. The remaining fields are then delegated to the
 * validator for that transport.
 *
 * @param {unknown} value - Raw mcpServers value from merged configuration.
 * @returns {McpServerConfig[]} The fully validated MCP server list, or an
 * empty array when mcpServers is not configured.
 * @throws {Error} If mcpServers is not an array, an entry is malformed,
 * server names are duplicated, a transport is unsupported, or any
 * transport-specific field is invalid.
 */
export function validateMcpServerConfigs(
  value: unknown,
): McpServerConfig[] {
  if (
    value === undefined
  ) {
    return [];
  }

  if (
    !Array.isArray(value)
  ) {
    throw new Error(
      "mcpServers must be an array",
    );
  }

  // MCP servers are referenced by name elsewhere, so duplicate names are
  // rejected before transport-specific validation can produce an ambiguous
  // configuration.
  const serverNames =
    new Set<string>();

  return value.map(
    (
      serverValue: unknown,
      index: number,
    ): McpServerConfig => {
      // Keep the original array position in error messages so users can
      // identify the exact configuration entry that needs correction.
      const fieldName =
        `mcpServers[${index}]`;

      if (
        !isRecord(serverValue)
      ) {
        throw new Error(
          `${fieldName} must be a JSON object`,
        );
      }

      const name =
        requireNonEmptyString(
          serverValue.name,
          `${fieldName}.name`,
        );

      if (
        serverNames.has(name)
      ) {
        throw new Error(
          `mcpServers contains duplicate server name "${name}"`,
        );
      }

      serverNames.add(name);

      // The transport discriminator determines which fields are required and
      // which specialized validator produces the final typed configuration.
      switch (
        serverValue.transport
      ) {
        case "stdio":
          return validateStdioServer(
            serverValue,
            fieldName,
            name,
          );

        case "sse":
          return validateSseServer(
            serverValue,
            fieldName,
            name,
          );

        case "http":
          return validateHttpServer(
            serverValue,
            fieldName,
            name,
          );

        default:
          throw new Error(
            `${fieldName}.transport must be "stdio", "sse", or "http" during MCP Sub-Step 2.3`,
          );
      }
    },
  );
}

/**
 * Type guard that determines whether an unknown value is one of Sky Code's
 * supported permission-mode strings.
 *
 * @param {unknown} value - The value to test.
 * @returns {boolean} True when the value is a valid PermissionMode; otherwise
 * false.
 */
export function isPermissionMode(
  value: unknown,
): value is PermissionMode {
  return (
    typeof value ===
      "string" &&
    PERMISSION_MODES.includes(
      value as PermissionMode,
    )
  );
}

/**
 * Validates and returns the configured default permission mode.
 *
 * @param {unknown} value - Raw defaultPermissionMode value to validate.
 * @returns {PermissionMode} The validated permission mode.
 * @throws {Error} If the value is not one of the supported permission modes.
 */
export function validatePermissionMode(
  value: unknown,
): PermissionMode {
  if (
    !isPermissionMode(
      value,
    )
  ) {
    throw new Error(
      'defaultPermissionMode must be one of "default", "auto-accept-edits", "plan", or "bypass"',
    );
  }

  return value;
}

/**
 * Validates that a configuration value is a positive safe integer.
 *
 * Requiring a safe integer prevents fractional, zero, negative, infinite,
 * or numerically unsafe values from being used for count-based settings.
 *
 * @param {unknown} value - Raw numeric value to validate.
 * @param {string} name - Configuration field name used in validation errors.
 * @returns {number} The validated positive whole number.
 * @throws {Error} If the value is not a safe integer greater than zero.
 */
function validatePositiveWholeNumber(
  value: unknown,
  name: string,
): number {
  if (
    typeof value !==
      "number" ||
    !Number.isSafeInteger(
      value,
    ) ||
    value < 1
  ) {
    throw new Error(
      `${name} must be a positive whole number`,
    );
  }

  return value;
}

/**
 * Type guard that determines whether an unknown value names one of Sky Code's
 * supported conversation-compaction strategies.
 *
 * @param {unknown} value - The value to test.
 * @returns {boolean} True when the value is a valid CompactionStrategy;
 * otherwise false.
 */
export function isCompactionStrategy(
  value: unknown,
): value is CompactionStrategy {
  return (
    typeof value ===
      "string" &&
    COMPACTION_STRATEGIES.includes(
      value as
        CompactionStrategy,
    )
  );
}

/**
 * Validates and returns the configured conversation-compaction strategy.
 *
 * @param {unknown} value - Raw compactionStrategy value to validate.
 * @returns {CompactionStrategy} The validated compaction strategy.
 * @throws {Error} If the value is not one of the supported strategies.
 */
export function validateCompactionStrategy(
  value: unknown,
): CompactionStrategy {
  if (
    !isCompactionStrategy(
      value,
    )
  ) {
    throw new Error(
      'compactionStrategy must be either "summarise" or "sliding-window"',
    );
  }

  return value;
}

/**
 * Loads, merges, and validates all configuration required to run Sky Code.
 *
 * JSON configuration is merged in increasing precedence: built-in defaults,
 * then ~/.sky-code/config.json, then the current project's
 * .sky-code/config.json. LITELLM_API_URL can override the merged apiUrl,
 * while the API key is read from LITELLM_API_KEY.
 *
 * @param {string} projectDirectory - Directory whose project-level
 * .sky-code/config.json should be loaded. Defaults to process.cwd().
 * @returns {Promise<AppConfig>} A fully populated and validated runtime
 * configuration object.
 * @throws {Error} If a configuration file cannot be read or parsed, or if
 * any required or configured value fails validation.
 *
 * Side effects: reads defaults, global configuration, and project
 * configuration files from the filesystem.
 */
export async function loadConfig(
  projectDirectory: string =
    process.cwd(),
): Promise<AppConfig> {
  const defaults =
    await readConfigFile(
      defaultsPath,
    );

  const globalConfigPath =
    join(
      homedir(),
      ".sky-code",
      "config.json",
    );

  const projectConfigPath =
    join(
      projectDirectory,
      ".sky-code",
      "config.json",
    );

  const globalConfig =
    await readConfigFile(
      globalConfigPath,
    );

  const projectConfig =
    await readConfigFile(
      projectConfigPath,
    );

  // Later spreads intentionally win over earlier ones. This gives project
  // configuration precedence over global configuration, which in turn takes
  // precedence over the application's built-in defaults.
  const mergedConfig:
    StoredConfig = {
      ...defaults,
      ...globalConfig,
      ...projectConfig,
    };

  // The API endpoint may be supplied through the environment, allowing an
  // environment-specific endpoint to take precedence over JSON configuration.
  const apiUrl =
    process.env
      .LITELLM_API_URL ??
    mergedConfig.apiUrl;

  // API credentials are intentionally sourced from the environment rather
  // than StoredConfig, so config.json does not provide an apiKey field.
  const apiKey =
    process.env
      .LITELLM_API_KEY;

  const defaultModel =
    mergedConfig
      .defaultModel;

  const defaultPermissionMode =
    mergedConfig
      .defaultPermissionMode;

  // This is the boundary between raw stored configuration and AppConfig:
  // every returned field is validated before the rest of Sky Code receives it.
  return {
    apiUrl:
      requireNonEmptyString(
        apiUrl,
        "LITELLM_API_URL or apiUrl",
      ),
    apiKey:
      requireNonEmptyString(
        apiKey,
        "LITELLM_API_KEY",
      ),
    defaultModel:
      requireNonEmptyString(
        defaultModel,
        "defaultModel",
      ),
    defaultPermissionMode:
      validatePermissionMode(
        defaultPermissionMode,
      ),
    compactionThreshold:
      validatePositiveWholeNumber(
        mergedConfig
          .compactionThreshold,
        "compactionThreshold",
      ),
    compactionStrategy:
      validateCompactionStrategy(
        mergedConfig
          .compactionStrategy,
      ),
    compactionWindowSize:
      validatePositiveWholeNumber(
        mergedConfig
          .compactionWindowSize,
        "compactionWindowSize",
      ),
    mcpServers:
      validateMcpServerConfigs(
        mergedConfig
          .mcpServers,
      ),
    pluginDirs:
      validateNonEmptyStringArray(
        mergedConfig
          .pluginDirs,
        "pluginDirs",
      ),
  };
}

/**
 * Canonical default content written to `~/.sky-code/sky.md` by `sky setup`
 * when that file does not already exist (see runSetupWizard() in setup.ts).
 *
 * This is the single source of truth for Sky Code's default operating
 * rules. Kept here, in source, specifically so future rule changes are one
 * code change shipped to every installation via a normal update, rather
 * than a file that has to be manually recreated or copied between
 * machines and can silently drift out of sync (as happened in practice
 * before this constant existed).
 *
 * `sky setup` never overwrites an existing sky.md, so a user's own edits
 * are always preserved; this default only ever applies to a fresh
 * installation that has no sky.md yet.
 */
export const DEFAULT_SKY_MD_CONTENT = `# Sky Code operating rules

These rules apply at all times, in every session, regardless of the active
permission mode (including \`bypass\`).

1. **Reason only from verified facts.** Never guess or invent dates,
   numbers, names, commands, prices, or sources. If uncertain, say so
   explicitly. If a request is unclear or missing important details, ask
   before answering or taking action.

2. **Confirm before destructive or irreversible actions.** This includes
   deleting files, force-pushing, overwriting without a backup, and
   dropping data. This holds even when the active permission mode would
   otherwise auto-approve it.

3. **Never fabricate command output or results.** Show real output only.
   Do not claim a command succeeded, a test passed, or a value was
   returned unless it was actually observed.

4. **Always verify build and tests pass before declaring a task done.**
   Run the project's build and test commands and check the actual result
   before reporting completion.

5. **Match existing code style and conventions** instead of introducing
   new patterns. Follow what the surrounding codebase already does.

6. **Prefer minimal, targeted diffs over broad refactors** unless
   specifically asked for a larger change.

7. **Never write any text before the sky-tool fenced block.** It must be
   the very first thing in your response, with nothing before it - no
   headings, no narration, nothing.
`;

/**
 * Loads the optional user-authored operating-rules file at
 * `~/.sky-code/sky.md`.
 *
 * `sky setup` seeds this file with DEFAULT_SKY_MD_CONTENT on a fresh
 * installation (see runSetupWizard() in setup.ts), but it remains a
 * regular, freely user-editable file afterward: there is no enforced
 * relationship between the two beyond that one-time seeding, and no
 * project-level variant today.
 *
 * @returns {Promise<string>} The trimmed file contents, or an empty string
 * if the file does not exist.
 * @throws {Error} If the file exists but cannot be read for a reason other
 * than not existing (for example, a permissions error), so a broken
 * installation is surfaced rather than silently ignored.
 *
 * Side effects: reads from the filesystem.
 */
export async function loadSkyMd(): Promise<string> {
  const skyMdPath =
    join(
      homedir(),
      ".sky-code",
      "sky.md",
    );

  try {
    const contents =
      await readFile(
        skyMdPath,
        "utf8",
      );

    return contents.trim();
  } catch (error) {
    const nodeError =
      error as NodeJS.ErrnoException;

    // Not having a sky.md file is the default, expected case: the feature is
    // opt-in and silently contributes nothing to the prompt when absent.
    if (
      nodeError.code ===
      "ENOENT"
    ) {
      return "";
    }

    throw new Error(
      `Unable to read ${skyMdPath}: ${
        error instanceof Error
          ? error.message
          : String(error)
      }`,
    );
  }
}
