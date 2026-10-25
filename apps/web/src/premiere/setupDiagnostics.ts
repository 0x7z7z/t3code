export interface AxisDiagnostics {
  readonly axis: string;
  readonly node: string | null;
  readonly git: string | null;
  readonly backend: string;
  readonly backendUrl: string;
  readonly extensionPath: string;
  readonly runtimePath: string | null;
  readonly dataPath: string;
  readonly workspacePath: string;
  readonly bridgePath: string;
  readonly ffmpeg: string | null;
  readonly bridgeState?: string;
  readonly python: {
    readonly version: string | null;
    readonly path: string | null;
    readonly whisperx: boolean;
  };
}

export function parseDiagnostics(value: unknown): AxisDiagnostics | null {
  if (!value || typeof value !== "object") return null;
  const report = value as Record<string, unknown>;
  for (const key of [
    "axis",
    "backend",
    "backendUrl",
    "extensionPath",
    "dataPath",
    "workspacePath",
    "bridgePath",
  ])
    if (typeof report[key] !== "string") return null;
  for (const key of ["node", "git", "runtimePath", "ffmpeg"])
    if (report[key] !== null && typeof report[key] !== "string") return null;
  if (!report.python || typeof report.python !== "object") return null;
  const python = report.python as Record<string, unknown>;
  if (
    typeof python.whisperx !== "boolean" ||
    (python.version !== null && typeof python.version !== "string") ||
    (python.path !== null && typeof python.path !== "string")
  )
    return null;
  return value as AxisDiagnostics;
}
