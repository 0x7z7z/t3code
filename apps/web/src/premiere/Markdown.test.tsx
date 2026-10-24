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

  it("only links http addresses", () => {
    expect(html("[docs](https://a.dev) [bad](javascript:alert(1))")).toBe(
      '<p><a href="https://a.dev" target="_blank" rel="noreferrer">docs</a> [bad](javascript:alert(1))</p>',
    );
  });
});
