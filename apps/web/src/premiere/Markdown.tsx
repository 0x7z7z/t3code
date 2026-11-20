import type { ReactNode } from "react";
import { ClipButton } from "./ClipButton";
import { clipNames, findClipNames } from "./clipLinks";
import type { TimelineActions } from "./interactiveHost";
import { Suggestions } from "./Suggestions";
import { suggestionKind } from "./suggestionBlocks";
import { findTimecodes, type TimecodeMatch } from "./timecode";

// A small Markdown subset for assistant replies. It builds React elements
// directly, so model output is never injected as HTML.

const INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^)\s]+\))/g;
const MD_ESCAPE = /\\([\\`*_{}[\]()#+\-.!|>~])/g;

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
    // Markdown backslash escapes such as \# and \+ show as the plain character.
    if (plain) return linkedText(part.replace(MD_ESCAPE, "$1"), key, onSeek, actions);
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
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function isTableStart(source: readonly string[], index: number): boolean {
  return TABLE_ROW.test(source[index] ?? "") && TABLE_RULE.test(source[index + 1] ?? "");
}

function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

/** Code blocks that hold Markdown with a table, such as a pasted .md file, read better rendered. */
function holdsMarkdownTable(language: string, code: readonly string[]): boolean {
  if (!["", "md", "markdown"].includes(language)) return false;
  return code.some((_, index) => isTableStart(code, index));
}

export function Markdown({
  text,
  onSeek,
  actions,
  complete = true,
}: {
  text: string;
  onSeek?: SeekHandler | undefined;
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
      const kind = actions
        ? suggestionKind(line.trim().slice(3).trim(), code.join("\n"), actions.fps)
        : null;
      if (actions && kind) {
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
      if (holdsMarkdownTable(line.trim().slice(3).trim().toLowerCase(), code)) {
        blocks.push(
          <div key={blocks.length} data-quoted-markdown="">
            <Markdown text={code.join("\n")} onSeek={onSeek} actions={actions} />
          </div>,
        );
        continue;
      }
      // Lines wrap in the narrow panel, and timestamps stay clickable.
      blocks.push(
        <pre key={blocks.length}>
          <code>{withTimecodes(code.join("\n"), 0, onSeek)}</code>
        </pre>,
      );
      continue;
    }
    if (isTableStart(source, index)) {
      flush();
      const head = tableCells(line);
      const rows: string[][] = [];
      index += 2;
      while (index < source.length && TABLE_ROW.test(source[index]!)) {
        rows.push(tableCells(source[index]!));
        index += 1;
      }
      blocks.push(
        <div key={blocks.length} data-table="">
          <table>
            <thead>
              <tr>
                {head.map((cell, column) => (
                  // oxlint-disable-next-line react/no-array-index-key -- Columns never reorder.
                  <th key={column}>{inline(cell, onSeek, 0, actions)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                // oxlint-disable-next-line react/no-array-index-key -- Rows never reorder.
                <tr key={rowIndex}>
                  {head.map((_, column) => (
                    // oxlint-disable-next-line react/no-array-index-key -- Columns never reorder.
                    <td key={column}>{inline(row[column] ?? "", onSeek, 0, actions)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
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
