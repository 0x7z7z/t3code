import { describe, expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "./Markdown";

const html = (text: string) => renderToStaticMarkup(<Markdown text={text} />);

describe("Markdown", () => {
  it("renders bold, code and line breaks", () => {
    expect(html("Project: **final.prproj**  \nSequences: `8`")).toBe(
      "<p>Project: <strong>final.prproj</strong><br/>Sequences: <code>8</code></p>",
    );
  });

  it("renders lists, headings and code blocks", () => {
    expect(html('## Plan\n- one\n- two\n\n1. first\n\n```json\n{"a":1}\n```')).toBe(
      "<h3>Plan</h3><ul><li>one</li><li>two</li></ul><ol><li>first</li></ol><pre><code>{&quot;a&quot;:1}</code></pre>",
    );
  });

  it("escapes markup instead of injecting it", () => {
    expect(html("<img src=x onerror=alert(1)>")).toBe("<p>&lt;img src=x onerror=alert(1)&gt;</p>");
  });

  it("renders pipe tables as tables, with escaped pipes kept in cells", () => {
    expect(html("| Part | Note |\n| --- | :--: |\n| P1 | a \\| b |\n| P2 |")).toBe(
      '<div data-table=""><table><thead><tr><th>Part</th><th>Note</th></tr></thead><tbody>' +
        "<tr><td>P1</td><td>a | b</td></tr><tr><td>P2</td><td></td></tr></tbody></table></div>",
    );
  });

  it("renders a quoted Markdown file with a table instead of a sideways-scrolling code block", () => {
    const quoted = html("```markdown\n# Notes\n| A | B |\n|---|---|\n| 1 | 2 |\n```");
    expect(quoted).toContain("<div data-quoted-markdown=");
    expect(quoted).toContain("<td>1</td>");
    expect(quoted).not.toContain("<pre>");
    // Other languages stay code.
    expect(html("```js\n| A | B |\n|---|---|\n```")).toContain("<pre>");
  });

  it("makes timestamps clickable inside tables and code blocks", () => {
    const seek = () => {};
    const rendered = renderToStaticMarkup(
      <Markdown
        text={"| P1 | 00:01:02:50 |\n|---|---|\n\n```\nAt 00:03:19:41 fix it\n```"}
        onSeek={seek}
      />,
    );
    expect(rendered.match(/data-timestamp/g)).toHaveLength(2);
  });

  it("shows Markdown escapes as plain characters", () => {
    expect(html("P2 \\+ P3, \\# and C:\\Users")).toBe("<p>P2 + P3, # and C:\\Users</p>");
  });

  it("only links http addresses", () => {
    expect(html("[docs](https://a.dev) [bad](javascript:alert(1))")).toBe(
      '<p><a href="https://a.dev" target="_blank" rel="noreferrer">docs</a> [bad](javascript:alert(1))</p>',
    );
  });
});
