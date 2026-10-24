import type { ReactNode } from "react";
import { findTimecodes, type TimecodeMatch } from "./timecode";

// A small Markdown subset for assistant replies. It builds React elements
// directly, so model output is never injected as HTML.

const INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))/g;

/** Called when the editor clicks a timestamp in a reply. */
export type SeekHandler = (timecode: TimecodeMatch) => void;

// Keys are character offsets: rendered text does not reorder, so they stay stable.
function withTimecodes(text: string, base: number, onSeek: SeekHandler | undefined): ReactNode[] {
  if (!onSeek) return [text];
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const timecode of findTimecodes(text)) {
    if (timecode.index > cursor) nodes.push(text.slice(cursor, timecode.index));
    nodes.push(
      <button
        key={`t${base + timecode.index}`}
        type="button"
        data-timestamp=""
        aria-label={`Move playhead to ${timecode.text}`}
        onClick={() => onSeek(timecode)}
      >
        {timecode.text}
      </button>,
    );
    cursor = timecode.index + timecode.text.length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

function inline(text: string, onSeek: SeekHandler | undefined, base = 0): ReactNode[] {
  let offset = base;
  let plain = false;
  return text.split(INLINE).flatMap((part): ReactNode[] => {
    const key = offset;
    offset += part.length;
    // split() with one capture group alternates plain text and tokens.
    plain = !plain;
    if (plain) return withTimecodes(part, key, onSeek);
    if (part.startsWith("`")) return [<code key={key}>{part.slice(1, -1)}</code>];
    if (part.startsWith("**"))
      return [<strong key={key}>{withTimecodes(part.slice(2, -2), key + 2, onSeek)}</strong>];
    const label = part.slice(1, part.indexOf("]("));
    const href = part.slice(part.indexOf("](") + 2, -1);
    return [
      <a key={key} href={href} target="_blank" rel="noreferrer">
        {label}
      </a>,
    ];
  });
}

function lines(text: string, onSeek: SeekHandler | undefined): ReactNode[] {
  let offset = 0;
  return text.split("\n").flatMap((line) => {
    const start = offset;
    offset += line.length + 1;
    const content = inline(line.replace(/\s+$/, ""), onSeek, start);
    return start === 0 ? content : [<br key={`br${start}`} />, ...content];
  });
}

const LIST_ITEM = /^\s*(?:[-*•]|(\d+)[.)])\s+(.*)$/;
const HEADING = /^#{1,6}\s+(.*)$/;

export function Markdown({ text, onSeek }: { text: string; onSeek?: SeekHandler }) {
  const blocks: ReactNode[] = [];
  const source = text.replace(/\r\n/g, "\n").split("\n");
  let paragraph: string[] = [];
  let index = 0;
  const flush = () => {
    if (paragraph.length)
      blocks.push(<p key={blocks.length}>{lines(paragraph.join("\n"), onSeek)}</p>);
    paragraph = [];
  };
  while (index < source.length) {
    const line = source[index]!;
    if (line.trimStart().startsWith("```")) {
      flush();
      const code: string[] = [];
      index += 1;
      while (index < source.length && !source[index]!.trimStart().startsWith("```")) {
        code.push(source[index]!);
        index += 1;
      }
      index += 1;
      blocks.push(
        <pre key={blocks.length}>
          <code>{code.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push(<h3 key={blocks.length}>{inline(heading[1]!, onSeek)}</h3>);
      index += 1;
      continue;
    }
    if (LIST_ITEM.test(line)) {
      flush();
      const ordered = LIST_ITEM.exec(line)![1] !== undefined;
      const entries: string[] = [];
      while (index < source.length) {
        const match = LIST_ITEM.exec(source[index]!);
        if (!match) break;
        entries.push(match[2]!);
        index += 1;
      }
      let position = index;
      const children = entries.map((entry) => {
        position += 1;
        return <li key={position}>{inline(entry, onSeek)}</li>;
      });
      blocks.push(
        ordered ? <ol key={blocks.length}>{children}</ol> : <ul key={blocks.length}>{children}</ul>,
      );
      continue;
    }
    if (!line.trim()) flush();
    else paragraph.push(line);
    index += 1;
  }
  flush();
  return <>{blocks}</>;
}
