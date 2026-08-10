/**
 * Custom command and skill catalog loading for Sky Code.
 *
 * Catalog entries are stored as JSON files under the user's Sky Code home
 * directory. This module validates their schema, protects built-in command
 * names, loads entries deterministically, rejects duplicates, and exposes a
 * normalized snapshot for command/skill runtime consumers.
 */
import {
  mkdir,
  readFile,
  readdir,
} from "node:fs/promises";

import {
  homedir,
} from "node:os";

import {
  extname,
  join,
} from "node:path";

/**
 * Supported top-level catalog entry categories.
 */
export type CatalogItemType =
  | "command"
  | "skill";

/**
 * Origin of a catalog item.
 *
 * `catalog` identifies user-managed JSON files in the catalog directory, while
 * `plugin` identifies items contributed by plugin integration.
 */
export type CatalogItemSource =
  | "catalog"
  | "plugin";

/**
 * Common metadata shared by every command and skill catalog item.
 */
export interface CatalogItemBase {
  /** Discriminates commands from skills. */
  type:
    CatalogItemType;

  /** Validated item name used for lookup and display. */
  name:
    string;

  /** Human-readable explanation of what the item does. */
  description:
    string;

  /** Indicates whether the item came from the local catalog or a plugin. */
  source:
    CatalogItemSource;

  /** Source file path retained for diagnostics and duplicate reporting. */
  filePath:
    string;
}

/**
 * Catalog command that expands to an AI prompt rather than executing a shell
 * command.
 */
export interface CatalogPromptCommand
  extends CatalogItemBase {
  type:
    "command";

  /** Prompt text submitted through the normal conversational command flow. */
  prompt:
    string;

  /** Prevents prompt commands from also defining shell execution text. */
  shell?:
    never;
}

/**
 * Catalog command that executes configured shell text.
 */
export interface CatalogShellCommand
  extends CatalogItemBase {
  type:
    "command";

  /** Shell command text associated with this catalog command. */
  shell:
    string;

  /** Prevents shell commands from also defining prompt text. */
  prompt?:
    never;
}

/**
 * Validated catalog command, discriminated by whether it contains `prompt` or
 * `shell` content.
 */
export type CatalogCommand =
  | CatalogPromptCommand
  | CatalogShellCommand;

/**
 * Catalog skill that contributes additional instructions to the model's system
 * prompt when activated.
 */
export interface CatalogSkill
  extends CatalogItemBase {
  type:
    "skill";

  /** Additional system-prompt instructions supplied by this skill. */
  systemPromptAddition:
    string;
}

/**
 * Any validated catalog entry.
 */
export type CatalogItem =
  | CatalogCommand
  | CatalogSkill;

/**
 * Fully loaded and validated view of one catalog directory.
 */
export interface CatalogSnapshot {
  /** Catalog directory that was loaded. */
  directory:
    string;

  /** Validated commands sorted by command name. */
  commands:
    CatalogCommand[];

  /** Validated skills sorted by skill name. */
  skills:
    CatalogSkill[];

  /** Combined command-then-skill list exposed to general catalog consumers. */
  items:
    CatalogItem[];
}

/**
 * Optional directory overrides used when loading a catalog.
 */
export interface LoadCatalogOptions {
  /** Home directory used to derive the default `.sky-code/catalog` path. */
  homeDirectory?:
    string;

  /** Explicit catalog path; when supplied, it takes precedence over homeDirectory. */
  catalogDirectory?:
    string;
}

/**
 * Built-in slash commands that user catalog files may not override.
 *
 * Keeping these names reserved prevents custom catalog entries from shadowing
 * core Sky Code control commands.
 */
export const RESERVED_CATALOG_COMMANDS =
  new Set<string>([
    "/model",
    "/permissions",
    "/compact",
    "/tasks",
    "/catalog",
    "/history",
  ]);

/**
 * Checks whether an unknown JSON value is a non-null, non-array object.
 *
 * @param {unknown} value - Value to inspect.
 * @returns {boolean} True when the value can be treated as a string-keyed record.
 *
 * Side effects: none.
 */
function isRecord(
  value:
    unknown,
): value is Record<
  string,
  unknown
> {
  return (
    typeof value ===
      "object" &&
    value !==
      null &&
    !Array.isArray(
      value,
    )
  );
}

/**
 * Validates and normalizes a required string field from a catalog JSON object.
 *
 * @param {unknown} value - Raw field value.
 * @param {string} fieldName - Field name used in validation errors.
 * @param {string} filePath - Catalog file path used for diagnostic context.
 * @returns {string} Trimmed non-empty string.
 * @throws {Error} If the value is not a string or contains only whitespace.
 *
 * Side effects: none.
 */
function requireNonEmptyString(
  value:
    unknown,

  fieldName:
    string,

  filePath:
    string,
): string {
  if (
    typeof value !==
      "string" ||
    value.trim() ===
      ""
  ) {
    throw new Error(
      `Catalog file ${filePath}: ${fieldName} must be a non-empty string`,
    );
  }

  return value.trim();
}

/**
 * Validates a catalog slash-command name.
 *
 * Names must start with `/`, use lowercase letters, numbers, hyphens, or
 * underscores, and must not conflict with a reserved built-in Sky Code command.
 *
 * @param {unknown} value - Raw command-name value.
 * @param {string} filePath - Catalog file path used for diagnostic context.
 * @returns {string} Validated command name.
 * @throws {Error} If the name is empty, malformed, or reserved.
 *
 * Side effects: none.
 */
function validateCommandName(
  value:
    unknown,

  filePath:
    string,
): string {
  const name =
    requireNonEmptyString(
      value,
      "name",
      filePath,
    );

  if (
    !/^\/[a-z0-9][a-z0-9_-]*$/.test(
      name,
    )
  ) {
    throw new Error(
      `Catalog file ${filePath}: command name must begin with "/" and use only lowercase letters, numbers, hyphens, and underscores`,
    );
  }

  if (
    RESERVED_CATALOG_COMMANDS.has(
      name,
    )
  ) {
    throw new Error(
      `Catalog file ${filePath}: command "${name}" conflicts with a built-in Sky Code command`,
    );
  }

  return name;
}

/**
 * Validates a catalog skill name.
 *
 * @param {unknown} value - Raw skill-name value.
 * @param {string} filePath - Catalog file path used for diagnostic context.
 * @returns {string} Validated lowercase skill name.
 * @throws {Error} If the name is empty or contains unsupported characters.
 *
 * Side effects: none.
 */
function validateSkillName(
  value:
    unknown,

  filePath:
    string,
): string {
  const name =
    requireNonEmptyString(
      value,
      "name",
      filePath,
    );

  if (
    !/^[a-z0-9][a-z0-9_-]*$/.test(
      name,
    )
  ) {
    throw new Error(
      `Catalog file ${filePath}: skill name must use only lowercase letters, numbers, hyphens, and underscores`,
    );
  }

  return name;
}

/**
 * Converts a validated JSON record into a prompt or shell catalog command.
 *
 * Exactly one of `prompt` and `shell` must be supplied. Shared metadata and the
 * selected command body are normalized before the discriminated command object
 * is returned.
 *
 * @param {Record<string, unknown>} value - Raw command JSON object.
 * @param {string} filePath - Source path used for provenance and errors.
 * @param {CatalogItemSource} source - Origin assigned to the parsed command.
 * @returns {CatalogCommand} Validated prompt-command or shell-command object.
 * @throws {Error} If required fields are invalid, the name is reserved, or both
 * or neither of `prompt` and `shell` are defined.
 *
 * Side effects: none.
 */
function parseCommand(
  value:
    Record<
      string,
      unknown
    >,

  filePath:
    string,

  source:
    CatalogItemSource,
): CatalogCommand {
  const name =
    validateCommandName(
      value.name,
      filePath,
    );

  const description =
    requireNonEmptyString(
      value.description,
      "description",
      filePath,
    );

  const prompt =
    value.prompt ===
      undefined
      ? undefined
      : requireNonEmptyString(
          value.prompt,
          "prompt",
          filePath,
        );

  const shell =
    value.shell ===
      undefined
      ? undefined
      : requireNonEmptyString(
          value.shell,
          "shell",
          filePath,
        );

  if (
    prompt !==
      undefined &&
    shell !==
      undefined
  ) {
    throw new Error(
      `Catalog file ${filePath}: command "${name}" must define either "prompt" or "shell", not both`,
    );
  }

  if (
    prompt ===
      undefined &&
    shell ===
      undefined
  ) {
    throw new Error(
      `Catalog file ${filePath}: command "${name}" must define either "prompt" or "shell"`,
    );
  }

  if (
    prompt !==
      undefined
  ) {
    return {
      type:
        "command",

      name,

      description,

      prompt,

      source,

      filePath,
    };
  }

  return {
    type:
      "command",

    name,

    description,

    shell:
      shell as string,

    source,

    filePath,
  };
}

/**
 * Converts a catalog JSON record into a validated skill.
 *
 * @param {Record<string, unknown>} value - Raw skill JSON object.
 * @param {string} filePath - Source path used for provenance and errors.
 * @param {CatalogItemSource} source - Origin assigned to the parsed skill.
 * @returns {CatalogSkill} Validated skill with normalized required strings.
 * @throws {Error} If the name, description, or systemPromptAddition is invalid.
 *
 * Side effects: none.
 */
function parseSkill(
  value:
    Record<
      string,
      unknown
    >,

  filePath:
    string,

  source:
    CatalogItemSource,
): CatalogSkill {
  return {
    type:
      "skill",

    name:
      validateSkillName(
        value.name,
        filePath,
      ),

    description:
      requireNonEmptyString(
        value.description,
        "description",
        filePath,
      ),

    systemPromptAddition:
      requireNonEmptyString(
        value
          .systemPromptAddition,
        "systemPromptAddition",
        filePath,
      ),

    source,

    filePath,
  };
}

/**
 * Parses one unknown JSON value into a validated catalog item.
 *
 * The value must be a JSON object with a supported `type`. Command and skill
 * validation is delegated to their specialized parsers. The default source is
 * `catalog`, while plugin callers may explicitly identify plugin-provided items.
 *
 * @param {unknown} value - Parsed JSON value to validate.
 * @param {string} filePath - Source path retained on the resulting item and used
 * in validation messages.
 * @param {CatalogItemSource} source - Item origin; defaults to `catalog`.
 * @returns {CatalogItem} Validated command or skill.
 * @throws {Error} If the value is not an object, has an invalid type, or fails
 * command/skill validation.
 *
 * Side effects: none.
 */
export function parseCatalogItem(
  value:
    unknown,

  filePath:
    string,

  source:
    CatalogItemSource =
      "catalog",
): CatalogItem {
  if (
    !isRecord(
      value,
    )
  ) {
    throw new Error(
      `Catalog file ${filePath} must contain a JSON object`,
    );
  }

  const type =
    requireNonEmptyString(
      value.type,
      "type",
      filePath,
    );

  switch (
    type
  ) {
    case "command":
      return parseCommand(
        value,
        filePath,
        source,
      );

    case "skill":
      return parseSkill(
        value,
        filePath,
        source,
      );

    default:
      throw new Error(
        `Catalog file ${filePath}: type must be either "command" or "skill"`,
      );
  }
}

/**
 * Resolves the default Sky Code catalog directory for a home directory.
 *
 * @param {string} homeDirectory - Home directory root; defaults to node:os
 * homedir().
 * @returns {string} `<homeDirectory>/.sky-code/catalog`.
 *
 * Side effects: none.
 */
export function getCatalogDirectory(
  homeDirectory:
    string =
      homedir(),
): string {
  return join(
    homeDirectory,
    ".sky-code",
    "catalog",
  );
}

/**
 * Reads, parses, and validates one catalog JSON file.
 *
 * Read failures and JSON parse failures are wrapped with the source path so a
 * user can identify the exact catalog file that needs correction.
 *
 * @param {string} filePath - JSON catalog file to load.
 * @returns {Promise<CatalogItem>} Validated catalog item from the file.
 * @throws {Error} If the file cannot be read, JSON cannot be parsed, or the
 * parsed item fails catalog validation.
 *
 * Side effects: reads the catalog file from disk.
 */
async function loadCatalogFile(
  filePath:
    string,
): Promise<CatalogItem> {
  let contents:
    string;

  try {
    contents =
      await readFile(
        filePath,
        "utf8",
      );
  } catch (error) {
    throw new Error(
      `Unable to read catalog file ${filePath}: ${
        error instanceof
          Error
          ? error.message
          : String(
              error,
            )
      }`,
    );
  }

  let parsed:
    unknown;

  try {
    parsed =
      JSON.parse(
        contents,
      );
  } catch (error) {
    throw new Error(
      `Unable to parse catalog file ${filePath}: ${
        error instanceof
          Error
          ? error.message
          : String(
              error,
            )
      }`,
    );
  }

  return parseCatalogItem(
    parsed,
    filePath,
  );
}

/**
 * Rejects duplicate command names and duplicate skill names.
 *
 * Commands and skills have separate namespaces, so a command and a skill may
 * share a name. Duplicate diagnostics include both source file paths.
 *
 * @param {readonly CatalogCommand[]} commands - Commands to check.
 * @param {readonly CatalogSkill[]} skills - Skills to check.
 * @returns {void}
 * @throws {Error} If two commands share a name or two skills share a name.
 *
 * Side effects: none.
 */
function rejectDuplicateItems(
  commands:
    readonly CatalogCommand[],

  skills:
    readonly CatalogSkill[],
): void {
  const commandOrigins =
    new Map<
      string,
      string
    >();

  for (
    const command of
    commands
  ) {
    const existingOrigin =
      commandOrigins.get(
        command.name,
      );

    if (
      existingOrigin !==
        undefined
    ) {
      throw new Error(
        `Duplicate catalog command "${command.name}" in ${existingOrigin} and ${command.filePath}`,
      );
    }

    commandOrigins.set(
      command.name,
      command.filePath,
    );
  }

  const skillOrigins =
    new Map<
      string,
      string
    >();

  for (
    const skill of
    skills
  ) {
    const existingOrigin =
      skillOrigins.get(
        skill.name,
      );

    if (
      existingOrigin !==
        undefined
    ) {
      throw new Error(
        `Duplicate catalog skill "${skill.name}" in ${existingOrigin} and ${skill.filePath}`,
      );
    }

    skillOrigins.set(
      skill.name,
      skill.filePath,
    );
  }
}

/**
 * Loads the local Sky Code catalog into a deterministic validated snapshot.
 *
 * The target directory is created if necessary with owner-only mode 0700.
 * Only regular files with a case-insensitive `.json` extension are considered.
 * File names are sorted before sequential loading so read/validation order is
 * stable; commands and skills are then independently sorted by item name.
 *
 * Duplicate names are rejected after all files have been parsed. The combined
 * `items` array intentionally places sorted commands before sorted skills.
 *
 * @param {LoadCatalogOptions} options - Optional home/catalog directory overrides.
 * @returns {Promise<CatalogSnapshot>} Loaded directory plus sorted commands,
 * skills, and combined items.
 * @throws {Error} If directory access fails, a catalog file cannot be loaded or
 * validated, or duplicate command/skill names are found.
 *
 * Side effects: creates the catalog directory when absent and reads catalog JSON
 * files from disk.
 */
export async function loadCatalog(
  options:
    LoadCatalogOptions = {},
): Promise<CatalogSnapshot> {
  const directory =
    options.catalogDirectory ??
    getCatalogDirectory(
      options.homeDirectory,
    );

  await mkdir(
    directory,
    {
      recursive:
        true,

      mode:
        0o700,
    },
  );

  const entries =
    await readdir(
      directory,
      {
        withFileTypes:
          true,
      },
    );

  const fileNames =
    entries
      .filter(
        (
          entry,
        ) =>
          entry.isFile() &&
          extname(
            entry.name,
          ).toLowerCase() ===
            ".json",
      )
      .map(
        (
          entry,
        ) =>
          entry.name,
      )
      .sort(
        (
          left,
          right,
        ) =>
          left.localeCompare(
            right,
          ),
      );

  const items:
    CatalogItem[] = [];

  for (
    const fileName of
    fileNames
  ) {
    items.push(
      await loadCatalogFile(
        join(
          directory,
          fileName,
        ),
      ),
    );
  }

  const commands =
    items
      .filter(
        (
          item,
        ): item is CatalogCommand =>
          item.type ===
            "command",
      )
      .sort(
        (
          left,
          right,
        ) =>
          left.name.localeCompare(
            right.name,
          ),
      );

  const skills =
    items
      .filter(
        (
          item,
        ): item is CatalogSkill =>
          item.type ===
            "skill",
      )
      .sort(
        (
          left,
          right,
        ) =>
          left.name.localeCompare(
            right.name,
          ),
      );

  rejectDuplicateItems(
    commands,
    skills,
  );

  return {
    directory,

    commands,

    skills,

    items: [
      ...commands,
      ...skills,
    ],
  };
}
