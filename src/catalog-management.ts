/**
 * Runtime management for Sky Code custom catalog commands and skills.
 *
 * This module parses `/catalog` management commands, formats catalog state,
 * imports and removes catalog JSON files, and tracks which catalog skills are
 * enabled for the current session. Catalog mutations are reloaded and validated
 * against active plugin skills before becoming the manager's current state.
 */
import { constants } from "node:fs";

import {
  copyFile,
  readFile,
  rm,
} from "node:fs/promises";

import {
  basename,
  extname,
  join,
  resolve,
} from "node:path";

import {
  loadCatalog,
  parseCatalogItem,
  type CatalogItem,
  type CatalogSkill,
  type CatalogSnapshot,
} from "./catalog.js";

import {
  selectEnabledCatalogSkills,
  validateCatalogPluginConflicts,
} from "./catalog-runtime.js";

import type {
  ActivePluginSkill,
} from "./plugins.js";

/**
 * Parsed `/catalog` management operation.
 *
 * The discriminated union represents listing the current catalog, importing a
 * JSON file, removing an item by name, or enabling/disabling a catalog skill for
 * the current session.
 */
export type CatalogManagementCommand =
  | {
      action:
        "list";
    }
  | {
      action:
        "add";

      file:
        string;
    }
  | {
      action:
        "remove";

      name:
        string;
    }
  | {
      action:
        "enable";

      name:
        string;
    }
  | {
      action:
        "disable";

      name:
        string;
    };

/**
 * Result returned after a catalog-management operation.
 *
 * Each result includes the user-facing message, the manager's current catalog
 * snapshot, and the catalog skills that are active for this session.
 */
export interface CatalogManagementResult {
  message:
    string;

  catalog:
    CatalogSnapshot;

  activeSkills:
    CatalogSkill[];
}

/**
 * Initial state and environment used to create a CatalogManager.
 */
export interface CatalogManagerOptions {
  catalog:
    CatalogSnapshot;

  pluginSkills?:
    readonly ActivePluginSkill[];

  workingDirectory?:
    string;
}

/**
 * Validates a required argument from a `/catalog` subcommand.
 *
 * @param {string} value - Raw argument text following the subcommand.
 * @param {string} usage - Usage syntax included in the error when missing.
 * @returns {string} Trimmed non-empty argument.
 * @throws {Error} If the argument is empty or only whitespace.
 *
 * Side effects: none.
 */
function requireArgument(
  value:
    string,

  usage:
    string,
): string {
  const trimmedValue =
    value.trim();

  if (
    trimmedValue ===
      ""
  ) {
    throw new Error(
      `Missing catalog command argument. Usage: ${usage}`,
    );
  }

  return trimmedValue;
}

/**
 * Parses raw user input as a `/catalog` management command.
 *
 * Input unrelated to `/catalog` returns null so other command handlers may
 * process it. A bare `/catalog`, unknown action, extra argument to `list`, or
 * missing required action argument throws a user-facing usage error.
 *
 * @param {string} userInput - Raw terminal input to inspect.
 * @returns {CatalogManagementCommand | null} Parsed catalog command, or null
 * when the input is not a `/catalog` command.
 * @throws {Error} If recognized `/catalog` syntax is incomplete or invalid.
 *
 * Side effects: none.
 */
export function parseCatalogManagementCommand(
  userInput:
    string,
): CatalogManagementCommand | null {
  const trimmedInput =
    userInput.trim();

  if (
    trimmedInput ===
      "/catalog"
  ) {
    throw new Error(
      "Usage: /catalog list | add <file> | remove <name> | enable <name> | disable <name>",
    );
  }

  if (
    !trimmedInput.startsWith(
      "/catalog ",
    )
  ) {
    return null;
  }

  const remainder =
    trimmedInput
      .slice(
        "/catalog ".length,
      )
      .trim();

  const firstSpace =
    remainder.indexOf(
      " ",
    );

  const action =
    (
      firstSpace ===
        -1
        ? remainder
        : remainder.slice(
            0,
            firstSpace,
          )
    ).trim();

  const argument =
    firstSpace ===
      -1
      ? ""
      : remainder
          .slice(
            firstSpace +
              1,
          )
          .trim();

  switch (
    action
  ) {
    case "list":
      if (
        argument !==
          ""
      ) {
        throw new Error(
          "Usage: /catalog list",
        );
      }

      return {
        action:
          "list",
      };

    case "add":
      return {
        action:
          "add",

        file:
          requireArgument(
            argument,
            "/catalog add <file>",
          ),
      };

    case "remove":
      return {
        action:
          "remove",

        name:
          requireArgument(
            argument,
            "/catalog remove <name>",
          ),
      };

    case "enable":
      return {
        action:
          "enable",

        name:
          requireArgument(
            argument,
            "/catalog enable <name>",
          ),
      };

    case "disable":
      return {
        action:
          "disable",

        name:
          requireArgument(
            argument,
            "/catalog disable <name>",
          ),
      };

    default:
      throw new Error(
        `Unknown catalog action "${action}". Usage: /catalog list | add <file> | remove <name> | enable <name> | disable <name>`,
      );
  }
}

/**
 * Formats the current custom catalog for terminal display.
 *
 * Commands are listed with their descriptions. Skills additionally show whether
 * their names are present in the current session's enabled-skill set.
 *
 * @param {CatalogSnapshot} catalog - Catalog snapshot to display.
 * @param {ReadonlySet<string>} enabledSkillNames - Skill names enabled for the
 * current session.
 * @returns {string} Multi-line catalog summary.
 *
 * Side effects: none.
 */
function formatCatalogList(
  catalog:
    CatalogSnapshot,

  enabledSkillNames:
    ReadonlySet<string>,
): string {
  const lines = [
    "Custom catalog:",
  ];

  if (
    catalog.commands.length ===
      0
  ) {
    lines.push(
      "Commands: none",
    );
  } else {
    lines.push(
      "Commands:",
    );

    for (
      const command of
      catalog.commands
    ) {
      lines.push(
        `- ${command.name}: ${command.description}`,
      );
    }
  }

  if (
    catalog.skills.length ===
      0
  ) {
    lines.push(
      "Skills: none",
    );
  } else {
    lines.push(
      "Skills:",
    );

    for (
      const skill of
      catalog.skills
    ) {
      const status =
        enabledSkillNames.has(
          skill.name,
        )
          ? "enabled"
          : "disabled";

      lines.push(
        `- ${skill.name} (${status}): ${skill.description}`,
      );
    }
  }

  return lines.join(
    "\n",
  );
}

/**
 * Reads and validates a JSON file before it is copied into the catalog.
 *
 * Validation occurs against the source file first, preventing malformed catalog
 * content from being copied into the managed catalog directory.
 *
 * @param {string} filePath - Candidate JSON file to import.
 * @returns {Promise<CatalogItem>} Validated catalog item represented by the file.
 * @throws {Error} If the file cannot be read, contains invalid JSON, or fails
 * catalog-item validation.
 *
 * Side effects: reads the candidate file from disk.
 */
async function readAndValidateImportFile(
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
      `Unable to read catalog import file ${filePath}: ${
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
      `Unable to parse catalog import file ${filePath}: ${
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
 * Manages catalog listing, imports, removal, and per-session skill activation.
 *
 * The manager owns the current CatalogSnapshot and the set of locally enabled
 * catalog skills. Plugin skills are retained for conflict validation whenever
 * the catalog is initially accepted or reloaded.
 *
 * File-changing operations reload the catalog so subsequent reads use validated
 * on-disk state. Failed imports are rolled back by deleting the copied file and
 * reloading the previous catalog state before the original error is rethrown.
 */
export class CatalogManager {
  /** Current validated catalog snapshot owned by the manager. */
  private catalog:
    CatalogSnapshot;

  /** Active plugin skills checked for naming conflicts with catalog skills. */
  private readonly pluginSkills:
    readonly ActivePluginSkill[];

  /** Base directory used to resolve relative paths supplied to `/catalog add`. */
  private readonly workingDirectory:
    string;

  /** Catalog skill names enabled only for the lifetime of this manager/session. */
  private readonly enabledSkillNames =
    new Set<string>();

  /**
   * Creates a catalog manager from an already-loaded catalog snapshot.
   *
   * @param {CatalogManagerOptions} options - Initial catalog, plugin skills, and
   * optional working-directory override.
   * @throws {Error} If the initial catalog conflicts with active plugin skills.
   *
   * Side effects: reads process.cwd() when no workingDirectory is supplied.
   */
  constructor(
    options:
      CatalogManagerOptions,
  ) {
    this.catalog =
      options.catalog;

    this.pluginSkills =
      options.pluginSkills ??
      [];

    this.workingDirectory =
      options.workingDirectory ??
      process.cwd();

    validateCatalogPluginConflicts(
      this.catalog,
      this.pluginSkills,
    );
  }

  /**
   * Returns the manager's current catalog snapshot.
   *
   * @returns {CatalogSnapshot} Current validated catalog snapshot.
   *
   * Side effects: none.
   */
  getSnapshot():
    CatalogSnapshot {
    return this.catalog;
  }

  /**
   * Returns a defensive copy of the session's enabled catalog skill names.
   *
   * @returns {ReadonlySet<string>} Independent set containing enabled names.
   *
   * Side effects: none.
   */
  getEnabledSkillNames():
    ReadonlySet<string> {
    return new Set(
      this.enabledSkillNames,
    );
  }

  /**
   * Resolves enabled skill names to the catalog skills currently available.
   *
   * @returns {CatalogSkill[]} Enabled catalog skills selected from the current
   * snapshot.
   *
   * Side effects: none.
   */
  getActiveSkills():
    CatalogSkill[] {
    return selectEnabledCatalogSkills(
      this.catalog.skills,
      this.enabledSkillNames,
    );
  }

  /**
   * Builds a management result from the manager's current state.
   *
   * @param {string} message - User-facing operation result.
   * @returns {CatalogManagementResult} Message, current catalog, and active
   * catalog skills.
   *
   * Side effects: none.
   */
  private createResult(
    message:
      string,
  ): CatalogManagementResult {
    return {
      message,

      catalog:
        this.catalog,

      activeSkills:
        this.getActiveSkills(),
    };
  }

  /**
   * Reloads and revalidates the managed catalog directory.
   *
   * After loading, plugin conflicts are checked again. Enabled skill names that
   * no longer exist are removed so session activation state cannot reference
   * deleted catalog skills.
   *
   * @returns {Promise<void>} Resolves after the catalog and enabled-name set are
   * synchronized with disk.
   * @throws {Error} If catalog loading/validation or plugin conflict validation
   * fails.
   *
   * Side effects: reads the catalog directory and may remove stale names from
   * enabledSkillNames.
   */
  private async reload():
    Promise<void> {
    this.catalog =
      await loadCatalog({
        catalogDirectory:
          this.catalog.directory,
      });

    validateCatalogPluginConflicts(
      this.catalog,
      this.pluginSkills,
    );

    const availableSkillNames =
      new Set(
        this.catalog.skills.map(
          (
            skill,
          ) =>
            skill.name,
        ),
      );

    for (
      const enabledName of
      this.enabledSkillNames
    ) {
      if (
        !availableSkillNames.has(
          enabledName,
        )
      ) {
        this.enabledSkillNames.delete(
          enabledName,
        );
      }
    }
  }

  /**
   * Executes one parsed catalog-management command.
   *
   * @param {CatalogManagementCommand} command - Operation to execute.
   * @returns {Promise<CatalogManagementResult>} Updated management result.
   * @throws {Error} When the selected operation fails validation or filesystem
   * work.
   *
   * Side effects: depending on the action, may read/write catalog files or
   * mutate this session's enabled-skill set.
   */
  async execute(
    command:
      CatalogManagementCommand,
  ): Promise<CatalogManagementResult> {
    switch (
      command.action
    ) {
      case "list":
        return this.createResult(
          formatCatalogList(
            this.catalog,
            this.enabledSkillNames,
          ),
        );

      case "add":
        return this.add(
          command.file,
        );

      case "remove":
        return this.remove(
          command.name,
        );

      case "enable":
        return this.enable(
          command.name,
        );

      case "disable":
        return this.disable(
          command.name,
        );
    }
  }

  /**
   * Imports a validated JSON catalog file into the managed catalog directory.
   *
   * Relative paths are resolved from workingDirectory. Imports must use a
   * `.json` extension and COPYFILE_EXCL prevents overwriting an existing file.
   * The source is validated before copying.
   *
   * If reloading the newly copied catalog fails, the destination file is
   * removed, the prior directory state is reloaded, and the original reload
   * error is rethrown. This keeps a bad import from remaining installed.
   *
   * @param {string} requestedPath - Absolute or working-directory-relative JSON
   * file path supplied by the user.
   * @returns {Promise<CatalogManagementResult>} Result for the successful import.
   * @throws {Error} If the extension is invalid, validation fails, source and
   * destination are the same, the destination already exists, copying fails, or
   * the resulting catalog cannot be reloaded.
   *
   * Side effects: reads the source file, may copy/remove a file in the catalog
   * directory, and reloads manager state.
   */
  private async add(
    requestedPath:
      string,
  ): Promise<CatalogManagementResult> {
    const sourcePath =
      resolve(
        this.workingDirectory,
        requestedPath,
      );

    if (
      extname(
        sourcePath,
      ).toLowerCase() !==
        ".json"
    ) {
      throw new Error(
        "Catalog import files must use the .json extension.",
      );
    }

    const item =
      await readAndValidateImportFile(
        sourcePath,
      );

    const destinationPath =
      join(
        this.catalog.directory,
        basename(
          sourcePath,
        ),
      );

    if (
      sourcePath ===
        destinationPath
    ) {
      throw new Error(
        `Catalog item is already stored at ${destinationPath}`,
      );
    }

    try {
      await copyFile(
        sourcePath,
        destinationPath,
        constants.COPYFILE_EXCL,
      );
    } catch (error) {
      const nodeError =
        error as
          NodeJS.ErrnoException;

      if (
        nodeError.code ===
          "EEXIST"
      ) {
        throw new Error(
          [
            `Catalog file "${basename(sourcePath)}" already exists in ${this.catalog.directory}.`,
            "Rename or remove the existing catalog file before adding another file with the same name.",
          ].join(
            " ",
          ),
        );
      }

      throw error;
    }

    try {
      await this.reload();
    } catch (error) {
      await rm(
        destinationPath,
        {
          force:
            true,
        },
      );

      await this.reload();

      throw error;
    }

    return this.createResult(
      `Added catalog ${item.type} "${item.name}".`,
    );
  }

  /**
   * Removes a catalog item by name and reloads manager state.
   *
   * If the removed item was an enabled skill, its session activation is cleared
   * before the catalog is reloaded.
   *
   * @param {string} name - Catalog command or skill name to remove.
   * @returns {Promise<CatalogManagementResult>} Result for the successful removal.
   * @throws {Error} If no item has the requested name, deletion fails, or reload
   * fails.
   *
   * Side effects: deletes the item's source file, updates enabled-skill state,
   * and reloads the catalog from disk.
   */
  private async remove(
    name:
      string,
  ): Promise<CatalogManagementResult> {
    const item =
      this.catalog.items.find(
        (
          candidate,
        ) =>
          candidate.name ===
            name,
      );

    if (
      item ===
        undefined
    ) {
      throw new Error(
        `Catalog item "${name}" was not found.`,
      );
    }

    await rm(
      item.filePath,
    );

    this.enabledSkillNames.delete(
      item.name,
    );

    await this.reload();

    return this.createResult(
      `Removed catalog ${item.type} "${item.name}".`,
    );
  }

  /**
   * Enables one catalog skill for the current session.
   *
   * @param {string} name - Catalog skill name to enable.
   * @returns {CatalogManagementResult} Updated state with the enabled skill.
   * @throws {Error} If the requested catalog skill does not exist.
   *
   * Side effects: adds the skill name to enabledSkillNames.
   */
  private enable(
    name:
      string,
  ): CatalogManagementResult {
    const skill =
      this.catalog.skills.find(
        (
          candidate,
        ) =>
          candidate.name ===
            name,
      );

    if (
      skill ===
        undefined
    ) {
      throw new Error(
        `Catalog skill "${name}" was not found.`,
      );
    }

    this.enabledSkillNames.add(
      skill.name,
    );

    return this.createResult(
      `Enabled catalog skill "${skill.name}" for this session.`,
    );
  }

  /**
   * Disables one catalog skill for the current session.
   *
   * @param {string} name - Catalog skill name to disable.
   * @returns {CatalogManagementResult} Updated state after disabling the skill.
   * @throws {Error} If the requested catalog skill does not exist.
   *
   * Side effects: removes the skill name from enabledSkillNames.
   */
  private disable(
    name:
      string,
  ): CatalogManagementResult {
    const skill =
      this.catalog.skills.find(
        (
          candidate,
        ) =>
          candidate.name ===
            name,
      );

    if (
      skill ===
        undefined
    ) {
      throw new Error(
        `Catalog skill "${name}" was not found.`,
      );
    }

    this.enabledSkillNames.delete(
      skill.name,
    );

    return this.createResult(
      `Disabled catalog skill "${skill.name}" for this session.`,
    );
  }
}
