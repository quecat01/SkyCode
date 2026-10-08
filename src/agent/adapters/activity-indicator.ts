/**
 * Wraps a completion client so a terminal activity indicator (Sky Code's
 * "Thinking..." spinner) runs for exactly as long as each request is in
 * flight.
 *
 * Two clients never write anything to the terminal themselves: the
 * PromptedStrategy selection client (its raw output is a JSON selection the
 * user should never see) and the native tool-calling client (its text is
 * only shown after NativeStrategy's final-answer check, so it cannot stream
 * live). Without this wrapper, every request they make is a silent wait with
 * nothing on screen, which reads as Sky Code being stuck. Wrapping them shows
 * the same indicator the visible streaming client already shows, and changes
 * nothing about what is requested, returned, or displayed afterward.
 *
 * The indicator is injected (in production, startThinkingIndicator(),
 * index.ts) so this module has no terminal dependency and is directly
 * testable.
 */
import type {
  NativeCompletionClient,
  TextCompletionClient,
} from "../model-client.js";

/**
 * Starts an activity indicator and returns a function that stops it. The
 * stop function must be safe to call more than once.
 */
export type StartActivityIndicator =
  () => () => void;

/**
 * Runs one request with the indicator active, stopping it however the
 * request ends.
 *
 * @template T
 * @param {StartActivityIndicator} start - Starts the indicator.
 * @param {() => Promise<T>} request - The request to run.
 * @returns {Promise<T>} The request's own result.
 * @throws {unknown} Whatever the request throws, unchanged, after the
 * indicator has been stopped.
 *
 * Side effects: starts and stops the indicator.
 */
async function whileIndicating<T>(
  start: StartActivityIndicator,
  request: () => Promise<T>,
): Promise<T> {
  const stop =
    start();

  try {
    return await request();
  } finally {
    // A thrown request (HTTP error, network failure) must never leave the
    // indicator running over the error message that follows.
    stop();
  }
}

/**
 * Wraps a TextCompletionClient so each complete() call shows the activity
 * indicator while it is in flight.
 *
 * @param {TextCompletionClient} client - The client to wrap.
 * @param {StartActivityIndicator} start - Starts the indicator.
 * @returns {TextCompletionClient} A client with identical behavior plus the
 * indicator.
 */
export function withTextActivityIndicator(
  client: TextCompletionClient,
  start: StartActivityIndicator,
): TextCompletionClient {
  return {
    complete(
      model,
      systemPrompt,
      turns,
      options,
    ) {
      return whileIndicating(
        start,
        () =>
          client.complete(
            model,
            systemPrompt,
            turns,
            options,
          ),
      );
    },
  };
}

/**
 * Wraps a NativeCompletionClient so each complete() call shows the activity
 * indicator while it is in flight.
 *
 * @param {NativeCompletionClient} client - The client to wrap.
 * @param {StartActivityIndicator} start - Starts the indicator.
 * @returns {NativeCompletionClient} A client with identical behavior plus
 * the indicator.
 */
export function withNativeActivityIndicator(
  client: NativeCompletionClient,
  start: StartActivityIndicator,
): NativeCompletionClient {
  return {
    complete(
      request,
    ) {
      return whileIndicating(
        start,
        () =>
          client.complete(
            request,
          ),
      );
    },
  };
}
