/**
 * Excel worksheet naming rules for Sky Code's create_xlsx tool.
 *
 * Holds the two pieces of naming logic shared by argument validation
 * (tools.ts) and workbook generation (xlsx.ts), with no dependency on any
 * spreadsheet library:
 * - findWorksheetNameProblem() checks one explicitly supplied name against
 *   Excel's own rules, so an invalid name is rejected before the tool runs
 *   instead of failing inside the generator or being silently truncated;
 * - resolveWorksheetNames() gives every sheet its final name, keeping each
 *   explicit name exactly and naming any sheet without one the way Excel
 *   itself does (Sheet1, Sheet2, ...).
 *
 * A worksheet name is a tab label, not project data, which is why a missing
 * one can be defaulted. Nothing here ever changes a name the model supplied.
 */

/** Excel's maximum worksheet name length, in characters. */
export const MAX_WORKSHEET_NAME_LENGTH = 31;

/** Characters Excel does not allow anywhere in a worksheet name. */
const FORBIDDEN_CHARACTERS = /[:\\/?*[\]]/;

/**
 * Checks one explicitly supplied worksheet name against Excel's rules.
 *
 * Uniqueness is not checked here, since it depends on the other sheets (see
 * validateXlsxSheets(), tools.ts).
 *
 * @param {string} name - A non-empty worksheet name.
 * @returns {string | undefined} A short description of the first rule the
 * name breaks, or undefined when it is valid.
 *
 * Side effects: none.
 */
export function findWorksheetNameProblem(
  name: string,
): string | undefined {
  if (
    name.length >
    MAX_WORKSHEET_NAME_LENGTH
  ) {
    return `must be at most ${MAX_WORKSHEET_NAME_LENGTH} characters (it has ${name.length})`;
  }

  if (
    FORBIDDEN_CHARACTERS.test(
      name,
    )
  ) {
    return "cannot contain any of these characters: : \\ / ? * [ ]";
  }

  if (
    name.startsWith("'") ||
    name.endsWith("'")
  ) {
    return "cannot start or end with an apostrophe (')";
  }

  // Excel reserves this name in any letter case.
  if (
    name.toLowerCase() ===
    "history"
  ) {
    return 'cannot be "History", which Excel reserves';
  }

  return undefined;
}

/**
 * Returns the final worksheet name for every sheet, in order.
 *
 * An explicit name is kept exactly. A sheet without one at position i gets
 * `Sheet{i+1}`; when that name is already used by another sheet (compared
 * ignoring case, as Excel does), it gets the next unused `SheetN` instead.
 * The result is deterministic and every name in it is unique.
 *
 * @param {ReadonlyArray<{name?: string}>} sheets - Validated sheets, whose
 * explicit names are already known to be valid and unique.
 * @returns {string[]} One name per sheet.
 *
 * Side effects: none.
 */
export function resolveWorksheetNames(
  sheets: ReadonlyArray<{
    name?: string;
  }>,
): string[] {
  // Every explicit name is reserved up front, so a default never takes a
  // name that a later sheet asks for explicitly.
  const taken =
    new Set(
      sheets.flatMap(
        (sheet) =>
          sheet.name !== undefined
            ? [sheet.name.toLowerCase()]
            : [],
      ),
    );

  return sheets.map(
    (sheet, index) => {
      if (sheet.name !== undefined) {
        return sheet.name;
      }

      let number =
        index + 1;

      while (
        taken.has(
          `sheet${number}`,
        )
      ) {
        number += 1;
      }

      const name =
        `Sheet${number}`;

      taken.add(
        name.toLowerCase(),
      );

      return name;
    },
  );
}
