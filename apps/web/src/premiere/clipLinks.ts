import * as Schema from "effect/Schema";
import * as Option from "effect/Option";

const seconds = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0));
const clipSchema = Schema.Struct({
  name: Schema.String.check(Schema.isMaxLength(512)),
  nodeId: Schema.String.check(Schema.isMaxLength(512)),
  trackType: Schema.Literals(["V", "A"]),
  trackIndex: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 10000 })),
  start: seconds,
  end: seconds,
});
export type TimelineClip = typeof clipSchema.Type;
const decodeClips = Schema.decodeUnknownOption(
  Schema.Array(clipSchema).check(Schema.isMaxLength(2000)),
);

export function parseClipIndex(value: unknown): readonly TimelineClip[] | null {
  const clips = Option.getOrNull(decodeClips(value));
  return clips?.some((clip) => clip.end < clip.start) ? null : clips;
}

const GENERIC =
  /^(?:clip|video|audio|image|still|sequence|untitled|adjustment layer|color matte|black video|nested sequence)(?:[ _-]*\d+)?$|^(?:silence|null|true|false)$/i;
export function clipNames(clips: readonly TimelineClip[]): string[] {
  return [...new Set(clips.map((clip) => clip.name))]
    .filter((name) => name.trim().length >= 3 && !GENERIC.test(name))
    .sort((a, b) => b.length - a.length || a.localeCompare(b));
}

export function findClipNames(text: string, names: readonly string[]) {
  if (!names.length) return [];
  const escaped = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}_])(?:${escaped.join("|")})(?![\\p{L}\\p{N}_])`,
    "gu",
  );
  return [...text.matchAll(pattern)].map((match) => ({ text: match[0], index: match.index }));
}
