import type { ReactNode } from "react";
import { ClipButton } from "./ClipButton";
import { clipNames, findClipNames } from "./clipLinks";
import type { TimelineActions } from "./interactiveHost";
import { Suggestions } from "./Suggestions";
import { findTimecodes, type TimecodeMatch } from "./timecode";

// A small Markdown subset for assistant replies. It builds React elements
// directly, so model output is never injected as HTML.

const INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^)\s]+\))/g;

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

function linkedText(
  text: string,
  base: number,
  onSeek: SeekHandler | undefined,
  actions: TimelineActions | undefined,
): ReactNode[] {
  if (!actions) return withTimecodes(text, base, onSeek);
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const match of findClipNames(text, clipNames(actions.clips))) {
    nodes.push(...withTimecodes(text.slice(cursor, match.index), base + cursor, onSeek));
    nodes.push(<ClipButton key={`c${base + match.index}`} name={match.text} actions={actions} />);
    cursor = match.index + match.text.length;
  }
  nodes.push(...withTimecodes(text.slice(cursor), base + cursor, onSeek));
  return nodes;
}

function inline(
  text: string,
  onSeek: SeekHandler | undefined,
  base = 0,
  actions?: TimelineActions,
): ReactNode[] {
  let offset = base;
  let plain = false;
  return text.split(INLINE).flatMap((part): ReactNode[] => {
    const key = offset;
    offset += part.length;
    // split() with one capture group alternates plain text and tokens.
    plain = !plain;
    if (plain) return linkedText(part, key, onSeek, actions);
    if (part.startsWith("`")) {
      const name = part.slice(1, -1);
      return [
        <code key={key}>
          {actions && clipNames(actions.clips).includes(name) ? (
            <ClipButton name={name} actions={actions} />
          ) : (
            name
          )}
        </code>,
      ];
    }
    if (part.startsWith("**"))
      return [<strong key={key}>{inline(part.slice(2, -2), onSeek, key + 2, actions)}</strong>];
    const label = part.slice(1, part.indexOf("]("));
    const href = part.slice(part.indexOf("](") + 2, -1);
    if (!/^https?:\/\//.test(href)) return [part];
    return [
      <a key={key} href={href} target="_blank" rel="noreferrer">
        {label}
      </a>,
    ];
  });
}

function lines(
  text: string,
  onSeek: SeekHandler | undefined,
  actions?: TimelineActions,
): ReactNode[] {
  let offset = 0;
  return text.split("\n").flatMap((line) => {
    const start = offset;
    offset += line.length + 1;
    const content = inline(line.replace(/\s+$/, ""), onSeek, start, actions);
    return start === 0 ? content : [<br key={`br${start}`} />, ...content];
  });
}

const LIST_ITEM = /^\s*(?:[-*•]|(\d+)[.)])\s+(.*)$/;
const HEADING = /^#{1,6}\s+(.*)$/;

export function Markdown({
  text,
  onSeek,
  actions,
  complete = true,
}: {
  text: string;
  onSeek?: SeekHandler;
  actions?: TimelineActions | undefined;
  complete?: boolean;
}) {
  const blocks: ReactNode[] = [];
  const source = text.replace(/\r\n/g, "\n").split("\n");
  let paragraph: string[] = [];
  let index = 0;
  const flush = () => {
    if (paragraph.length)
      blocks.push(<p key={blocks.length}>{lines(paragraph.join("\n"), onSeek, actions)}</p>);
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
      const closed = index < source.length;
      index += 1;
      const kind = line.trim().slice(3).trim();
      if (actions && (kind === "axis-markers" || kind === "axis-shots")) {
        blocks.push(
          <Suggestions
            key={`suggestion-${index}`}
            kind={kind}
            source={code.join("\n")}
            actions={actions}
            complete={complete && closed}
          />,
        );
        continue;
      }
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
      blocks.push(<h3 key={blocks.length}>{inline(heading[1]!, onSeek, 0, actions)}</h3>);
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
        return <li key={position}>{inline(entry, onSeek, 0, actions)}</li>;
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
