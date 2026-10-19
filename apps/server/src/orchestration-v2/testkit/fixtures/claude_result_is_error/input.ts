import {
  CLAUDE_RESULT_IS_ERROR_FOLLOW_UP,
  CLAUDE_RESULT_IS_ERROR_PROMPT,
  type OrchestratorFixtureInput,
} from "../shared.ts";

/**
 * The SDK reports API-level failures (401 auth, 529 overloaded, ...) with
 * subtype "success" and is_error: true, alongside a synthetic-model
 * assistant message carrying the error text.
 */
export function claudeResultIsErrorInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: CLAUDE_RESULT_IS_ERROR_PROMPT },
      { type: "message", text: CLAUDE_RESULT_IS_ERROR_FOLLOW_UP },
    ],
  };
}
