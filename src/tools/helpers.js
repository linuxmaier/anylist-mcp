import { z } from "zod";

// Tool annotations for the three tiers each category is split into (#38).
// Clients grant permissions per tool, so a tool must never mix tiers:
// *_read never writes, and only *_delete removes anything.
export const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
export const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
export const DELETE = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

/**
 * The `action` parameter and handler of a tier tool. The SDK already checks
 * `action` against the enum; the handler checks again, so a tool can only
 * ever run its own tier's actions.
 * @param {string[]} actions
 * @param {(action: string, params: object) => Promise<object>} run
 * @param {string} description - of the `action` parameter
 */
export function tierActions(actions, run, description) {
  return {
    action: z.enum(actions).describe(description),
    handler: params => (actions.includes(params.action)
      ? run(params.action, params)
      : errorResponse(`Unknown action "${params.action}". This tool's actions: ${actions.join(", ")}`)),
  };
}

export function errorResponse(msg) {
  return { content: [{ type: "text", text: msg }], isError: true };
}

export function textResponse(msg) {
  return { content: [{ type: "text", text: msg }] };
}

export function requireParams(params, required, action) {
  for (const key of required) {
    if (params[key] === undefined || params[key] === null || params[key] === "") {
      throw new Error(`Action "${action}" requires parameter "${key}"`);
    }
  }
}
