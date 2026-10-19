/**
 * Grok's launch-time updater runs during background probes and opens an npm console
 * on Windows. Suppress it only for probes, preserving the caller's update settings
 * for sessions, text generation, and explicit updates.
 */
export function grokProbeEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...environment, GROK_DISABLE_AUTOUPDATER: "1" };
}
