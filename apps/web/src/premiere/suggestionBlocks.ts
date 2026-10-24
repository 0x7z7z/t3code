import * as Schema from "effect/Schema";
import * as Option from "effect/Option";

const seconds = Schema.Number.check(
  Schema.isFinite(),
  Schema.isBetween({ minimum: 0, maximum: 8640000 }),
);
const shortText = Schema.String.check(Schema.isMaxLength(512));
const comment = Schema.String.check(Schema.isMaxLength(2000));
const time = Schema.Union([seconds, Schema.String.check(Schema.isMaxLength(32))]);
const color = Schema.Literals([
  "red",
  "orange",
  "yellow",
  "green",
  "cyan",
  "blue",
  "purple",
  "magenta",
]);
const markerSchema = Schema.Struct({
  time,
  name: shortText,
  comment: Schema.optional(comment),
  color: Schema.optional(color),
  duration: Schema.optional(seconds),
});
const shotSchema = Schema.Struct({
  shot: shortText,
  in: time,
  out: time,
  description: comment,
  source: Schema.optional(shortText),
  notes: Schema.optional(comment),
  status: Schema.optional(Schema.Literals(["todo", "done"])),
});
const decodeMarkers = Schema.decodeUnknownOption(
  Schema.Array(markerSchema).check(Schema.isMinLength(1), Schema.isMaxLength(200)),
);
const decodeShots = Schema.decodeUnknownOption(
  Schema.Array(shotSchema).check(Schema.isMinLength(1), Schema.isMaxLength(200)),
);

export const markerColors = {
  green: 0,
  red: 1,
  purple: 2,
  magenta: 2,
  orange: 3,
  yellow: 4,
  blue: 6,
  cyan: 7,
} satisfies Record<typeof color.Type, number>;
export type MarkerSuggestion = Omit<typeof markerSchema.Type, "time"> & { readonly time: number };
export interface PlanShot {
  readonly shotId: string;
  readonly timelineInSeconds: number;
  readonly timelineOutSeconds: number;
  readonly durationSeconds: number;
  readonly rationale: string;
  readonly assetName: string;
  readonly notes: string;
  readonly status: "todo" | "done";
}

export function parseSuggestionTime(value: string | number, fps: number): number {
  if (!Number.isFinite(fps) || fps <= 0 || fps > 240)
    throw new Error("No valid sequence frame rate.");
  if (typeof value === "number") return value;
  const match = /^(\d{2}):([0-5]\d):([0-5]\d):(\d{2})$/.exec(value);
  if (!match || Number(match[4]) >= Math.ceil(fps))
    throw new Error("Use seconds or HH:MM:SS:FF timecodes.");
  return (
    Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / fps
  );
}

export type ParsedSuggestion =
  | { readonly kind: "markers"; readonly markers: readonly MarkerSuggestion[] }
  | { readonly kind: "shots"; readonly shots: readonly PlanShot[] }
  | { readonly kind: "invalid"; readonly error: string };

export function parseSuggestion(kind: string, source: string, fps: number): ParsedSuggestion {
  try {
    if (source.length > 600000) throw new Error("Suggestion block is too large.");
    const value: unknown = JSON.parse(source);
    if (kind === "axis-markers") {
      const rows = Option.getOrNull(decodeMarkers(value, { onExcessProperty: "error" }));
      if (!rows) throw new Error("Expected 1-200 valid markers.");
      const markers = rows.map((row) => ({ ...row, time: parseSuggestionTime(row.time, fps) }));
      if (new Set(markers.map((row) => JSON.stringify(row))).size !== markers.length)
        throw new Error("Duplicate markers are not supported.");
      if (markers.some((row) => row.time + (row.duration ?? 0) > 8640000))
        throw new Error("Marker range is too large.");
      return { kind: "markers", markers };
    }
    const rows = Option.getOrNull(decodeShots(value, { onExcessProperty: "error" }));
    if (!rows) throw new Error("Expected 1-200 valid shots.");
    const ids = new Set<string>();
    const shots = rows.map((row): PlanShot => {
      const start = parseSuggestionTime(row.in, fps);
      const end = parseSuggestionTime(row.out, fps);
      if (!row.shot.trim() || ids.has(row.shot))
        throw new Error("Shot IDs must be nonempty and unique.");
      if (end <= start) throw new Error("Shot out must be after in.");
      ids.add(row.shot);
      return {
        shotId: row.shot,
        timelineInSeconds: start,
        timelineOutSeconds: end,
        durationSeconds: end - start,
        rationale: row.description,
        assetName: row.source ?? "",
        notes: row.notes ?? "",
        status: row.status ?? "todo",
      };
    });
    return { kind: "shots", shots };
  } catch (error) {
    return {
      kind: "invalid",
      error: error instanceof Error ? error.message : "Invalid suggestion block.",
    };
  }
}

export function shotMarkers(shots: readonly PlanShot[]): MarkerSuggestion[] {
  return shots.map((shot) => ({
    time: shot.timelineInSeconds,
    duration: shot.durationSeconds,
    name: `Shot ${shot.shotId}`.slice(0, 512),
    comment: [shot.rationale, shot.assetName, shot.notes].filter(Boolean).join("\n").slice(0, 2000),
    color: shot.status === "done" ? "green" : "blue",
  }));
}

export function shotsCsv(shots: readonly PlanShot[]): string {
  const cell = (value: string | number) => {
    const text = String(value);
    // Prevent spreadsheet formulas when a plan contains model-written text.
    return `"${(/^[=+\-@\t\r]/.test(text) ? "'" + text : text).replaceAll('"', '""')}"`;
  };
  return [
    [
      "shot_id",
      "timeline_in_seconds",
      "timeline_out_seconds",
      "duration_seconds",
      "rationale",
      "asset_name",
      "notes",
      "status",
    ],
    ...shots.map((shot) => [
      shot.shotId,
      shot.timelineInSeconds,
      shot.timelineOutSeconds,
      shot.durationSeconds,
      shot.rationale,
      shot.assetName,
      shot.notes,
      shot.status,
    ]),
  ]
    .map((row) => row.map(cell).join(","))
    .join("\r\n");
}

/** Which card a fence should render as. Plain JSON fences count when they hold a valid list. */
export function suggestionKind(
  fence: string,
  source: string,
  fps: number,
): "axis-markers" | "axis-shots" | null {
  if (fence === "axis-markers" || fence === "axis-shots") return fence;
  if (fence !== "json" && fence !== "") return null;
  for (const kind of ["axis-shots", "axis-markers"] as const)
    if (parseSuggestion(kind, source, fps).kind !== "invalid") return kind;
  return null;
}
