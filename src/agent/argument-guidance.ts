/**
 * Concrete correction guidance for a native tool call whose arguments were
 * rejected before the tool ran.
 *
 * A rejected call executes nothing. What the model needs in order to fix it,
 * especially a smaller local model, is more than "your arguments were
 * invalid": the exact validation error, the shape the tool expects, and one
 * canonical example. All of that comes from the tool's own canonical
 * ToolDefinition (its JSON Schema parameters and its examples), the same
 * source the native tool definitions and validation use, so nothing here is
 * written for any particular tool.
 */
import type {
  JsonSchema,
  ToolDefinition,
} from "./types.js";

/**
 * The two ways a native call's arguments can be rejected before running.
 */
export type ArgumentRejectionCode =
  | "TOOL_ARGUMENTS_INVALID_JSON"
  | "TOOL_ARGUMENT_VALIDATION_FAILED";

/** Upper bound on the expected-arguments summary, in characters. */
const MAX_SUMMARY_LENGTH = 1200;

/** Upper bound on the example arguments text, in characters. */
const MAX_EXAMPLE_LENGTH = 1500;

/** Nesting depth beyond which the summary stops expanding a schema. */
const MAX_SUMMARY_DEPTH = 8;

/**
 * Narrows to a plain JSON-Schema-like record.
 *
 * @param {unknown} value - Candidate schema node.
 * @returns {boolean} True for a non-array object.
 */
function isSchema(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

/**
 * Describes one JSON Schema node in a compact, TypeScript-like notation,
 * e.g. `{ path: string, slides: array (at least 1) of { type: "title", ... } }`.
 *
 * @param {unknown} schema - A schema node.
 * @param {number} depth - Current nesting depth.
 * @returns {string} The compact description.
 */
function describeSchema(
  schema: unknown,
  depth: number,
): string {
  if (!isSchema(schema)) {
    return "any";
  }

  if ("const" in schema) {
    return JSON.stringify(schema.const);
  }

  if (Array.isArray(schema.enum)) {
    return schema.enum
      .map(
        (value) => JSON.stringify(value),
      )
      .join(" | ");
  }

  const variants =
    Array.isArray(schema.oneOf)
      ? schema.oneOf
      : Array.isArray(schema.anyOf)
        ? schema.anyOf
        : undefined;

  if (variants) {
    return depth >= MAX_SUMMARY_DEPTH
      ? "(one of several shapes)"
      : variants
          .map(
            (variant) =>
              describeSchema(
                variant,
                depth + 1,
              ),
          )
          .join(" | ");
  }

  if (schema.type === "array") {
    const minItems =
      typeof schema.minItems === "number" &&
      schema.minItems > 0
        ? ` (at least ${schema.minItems})`
        : "";

    return depth >= MAX_SUMMARY_DEPTH
      ? `array${minItems}`
      : `array${minItems} of ${describeSchema(schema.items, depth + 1)}`;
  }

  if (
    schema.type === "object" ||
    isSchema(schema.properties)
  ) {
    if (depth >= MAX_SUMMARY_DEPTH) {
      return "object";
    }

    const properties =
      isSchema(schema.properties)
        ? schema.properties
        : {};

    const required =
      new Set(
        Array.isArray(schema.required)
          ? schema.required.map(String)
          : [],
      );

    const fields =
      Object.entries(properties).map(
        ([name, child]) =>
          `${name}${required.has(name) ? "" : "?"}: ${describeSchema(child, depth + 1)}`,
      );

    return fields.length === 0
      ? "object"
      : `{ ${fields.join(", ")} }`;
  }

  return typeof schema.type === "string"
    ? schema.type
    : "any";
}

/**
 * Trims text to a maximum length, marking the cut.
 *
 * @param {string} text - Text to trim.
 * @param {number} max - Maximum length.
 * @returns {string} The trimmed text.
 */
function clip(
  text: string,
  max: number,
): string {
  return text.length > max
    ? `${text.slice(0, max)}...`
    : text;
}

/**
 * Summarizes the arguments a tool expects, from its canonical schema.
 * Optional fields are marked with "?".
 *
 * @param {JsonSchema} parameters - The tool's parameters schema.
 * @returns {string} The compact summary.
 *
 * Side effects: none.
 */
export function summarizeExpectedArguments(
  parameters: JsonSchema,
): string {
  return clip(
    describeSchema(
      parameters,
      0,
    ),
    MAX_SUMMARY_LENGTH,
  );
}

/**
 * Builds the not-executed tool result text for a rejected native call.
 *
 * @param {ToolDefinition | undefined} definition - The tool's canonical
 * definition, when known.
 * @param {string} tool - The tool name the model called.
 * @param {ArgumentRejectionCode} code - Why the arguments were rejected.
 * @param {string} detail - The JSON parse error or validation error.
 * @returns {string} Plain text naming the error, the expected shape, and a
 * canonical example.
 *
 * Side effects: none.
 */
export function buildArgumentRejectionText(
  definition: ToolDefinition | undefined,
  tool: string,
  code: ArgumentRejectionCode,
  detail: string,
): string {
  const reason =
    detail.trim() === ""
      ? "no further detail was reported"
      : detail.trim().replace(/\.$/, "");

  const problem =
    code === "TOOL_ARGUMENTS_INVALID_JSON"
      ? `The arguments were not valid JSON (${reason}).`
      : `Validation error: ${reason}.`;

  const parts = [
    `Not executed: the arguments for ${tool} were rejected before the tool ran, so nothing was done.`,
    problem,
    `Correct the arguments and call ${tool} again.`,
  ];

  if (definition) {
    parts.push(
      `Expected arguments (fields marked ? are optional): ${summarizeExpectedArguments(definition.parameters)}.`,
    );

    const example =
      definition.examples[0]?.arguments;

    if (example !== undefined) {
      parts.push(
        `Example arguments: ${clip(JSON.stringify(example), MAX_EXAMPLE_LENGTH)}`,
      );
    }
  }

  return parts.join(" ");
}
