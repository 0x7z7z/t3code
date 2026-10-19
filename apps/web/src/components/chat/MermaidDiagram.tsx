import DOMPurify from "dompurify";
import type { Mermaid } from "mermaid";
import { use, useState } from "react";

import { Button } from "../ui/button";

type MermaidRenderResult =
  | { readonly status: "rendered"; readonly svg: string }
  | { readonly status: "error"; readonly message: string; readonly retryable: boolean };

let mermaidModulePromise: Promise<Mermaid> | null = null;
let renderQueue: Promise<unknown> = Promise.resolve();
let nextDiagramId = 0;
const MAX_CACHED_RENDERS = 64;
// Do not evict pending renders: use() retries need the same promise.
const renderCache = new Map<string, Promise<MermaidRenderResult>>();
const settledRenders = new WeakSet<Promise<MermaidRenderResult>>();

function loadMermaid(): Promise<Mermaid> {
  mermaidModulePromise ??= import("mermaid")
    .then((module) => module.default)
    .catch((error: unknown) => {
      mermaidModulePromise = null;
      throw error;
    });
  return mermaidModulePromise;
}

const REMOTE_CSS_URL = /url\(\s*(?!['"]?#)[^)]*\)/gi;
let purifier: ReturnType<typeof DOMPurify> | null = null;

const KATEX_MATHML_TAGS = new Set([
  "math",
  "menclose",
  "mfrac",
  "mi",
  "mlabeledtr",
  "mn",
  "mo",
  "mover",
  "mpadded",
  "mphantom",
  "mroot",
  "mrow",
  "mspace",
  "msqrt",
  "mstyle",
  "msub",
  "msubsup",
  "msup",
  "mtable",
  "mtd",
  "mtext",
  "mtr",
  "munder",
  "munderover",
]);
const KATEX_MATHML_ATTRIBUTES = new Set([
  "accent",
  "accentunder",
  "columnalign",
  "columnlines",
  "columnspacing",
  "depth",
  "displaystyle",
  "fence",
  "largeop",
  "linebreak",
  "linethickness",
  "lspace",
  "mathbackground",
  "mathcolor",
  "mathsize",
  "mathvariant",
  "maxsize",
  "minsize",
  "notation",
  "rowlines",
  "rowspacing",
  "rspace",
  "scriptlevel",
  "separator",
  "stretchy",
  "voffset",
]);

// Untrusted PR descriptions need stricter sanitization than Mermaid provides.
export function sanitizeMermaidSvg(svg: string): string {
  if (!purifier) {
    purifier = DOMPurify(window);
    purifier.addHook("uponSanitizeElement", (node, data) => {
      if (data.tagName === "style" && node.textContent) {
        node.textContent = node.textContent.replace(REMOTE_CSS_URL, "none");
      }
    });
    purifier.addHook("uponSanitizeAttribute", (_node, data) => {
      if (data.attrName === "style")
        data.attrValue = data.attrValue.replace(REMOTE_CSS_URL, "none");
    });
  }
  const sanitized = purifier.sanitize(svg, {
    // DOMPurify requires an HTML parent for <math> and validates MathML namespaces.
    ADD_TAGS: ["foreignObject", ...KATEX_MATHML_TAGS],
    ADD_ATTR: (attribute, tagName) =>
      KATEX_MATHML_TAGS.has(tagName) && KATEX_MATHML_ATTRIBUTES.has(attribute),
    HTML_INTEGRATION_POINTS: { foreignobject: true },
    FORBID_ATTR: ["href", "xlink:href", "src", "srcset"],
    FORBID_TAGS: ["a", "img", "image", "script"],
    USE_PROFILES: { svg: true, svgFilters: true, html: true },
  });
  // HTML serializes KaTeX spaces as &nbsp;, which expanded-image XML cannot parse.
  return sanitized.replaceAll("&nbsp;", "&#160;");
}

// Mermaid lazy-loads during render(); retry network failures, not syntax errors.
const CHUNK_LOAD_ERROR = /dynamically imported module|importing a module script|failed to fetch/i;

async function renderMermaid(
  source: string,
  theme: "light" | "dark",
): Promise<MermaidRenderResult> {
  const id = `mermaid-diagram-${nextDiagramId++}`;
  let mermaid: Mermaid;
  try {
    mermaid = await loadMermaid();
  } catch {
    return { status: "error", message: "Mermaid failed to load.", retryable: true };
  }
  try {
    // initialize() mutates global config, so serialize renders.
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      // Mermaid mounts labels and theme CSS before sanitizing; block directive overrides.
      secure: [
        "secure",
        "securityLevel",
        "startOnLoad",
        "maxTextSize",
        "suppressErrorRendering",
        "maxEdges",
        "htmlLabels",
        "themeCSS",
      ],
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      theme: theme === "dark" ? "dark" : "default",
      fontFamily: getComputedStyle(document.body).fontFamily,
    });
    const { svg } = await mermaid.render(id, source);
    return { status: "rendered", svg: sanitizeMermaidSvg(svg) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "The diagram could not be rendered.";
    return { status: "error", message, retryable: CHUNK_LOAD_ERROR.test(message) };
  } finally {
    document.getElementById(`d${id}`)?.remove();
  }
}

function evictSettledRenders() {
  for (const [key, result] of renderCache) {
    if (renderCache.size <= MAX_CACHED_RENDERS) return;
    if (settledRenders.has(result)) renderCache.delete(key);
  }
}

function mermaidRenderKey(source: string, theme: "light" | "dark") {
  return `${theme}\n${source}`;
}

function mermaidRenderPromise(source: string, theme: "light" | "dark") {
  const key = mermaidRenderKey(source, theme);
  const cached = renderCache.get(key);
  if (cached) {
    renderCache.delete(key);
    renderCache.set(key, cached);
    return cached;
  }
  const result = renderQueue.then(() => renderMermaid(source, theme));
  renderQueue = result;
  void result.then(() => {
    settledRenders.add(result);
    evictSettledRenders();
  });
  renderCache.set(key, result);
  evictSettledRenders();
  return result;
}

let expandedImageUrl: string | null = null;

// Desktop save/copy fetches allow blob URLs through connect-src, but reject data URLs.
function mermaidImageUrl(svg: string): string {
  const svgDocument = new DOMParser().parseFromString(svg, "image/svg+xml");
  const element = svgDocument.documentElement;
  const viewBox = element.getAttribute("viewBox")?.trim().split(/\s+/).map(Number);
  if (viewBox?.length === 4 && viewBox.every(Number.isFinite)) {
    element.setAttribute("width", String(viewBox[2]));
    element.setAttribute("height", String(viewBox[3]));
  }
  element.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  element.style.maxWidth = "none";
  const { backgroundColor, color } = getComputedStyle(document.body);
  element.style.backgroundColor = backgroundColor;
  element.style.color = color;
  if (expandedImageUrl) URL.revokeObjectURL(expandedImageUrl);
  expandedImageUrl = URL.createObjectURL(
    new Blob([new XMLSerializer().serializeToString(element)], { type: "image/svg+xml" }),
  );
  return expandedImageUrl;
}

export function MermaidDiagram({
  source,
  theme,
  onExpand,
}: {
  source: string;
  theme: "light" | "dark";
  onExpand: (imageUrl: string) => void;
}) {
  const [, setAttempt] = useState(0);
  const result = use(mermaidRenderPromise(source.trim(), theme));

  if (result.status === "error") {
    return (
      <div>
        <div className="flex items-center justify-between gap-2">
          <p className="m-0 text-xs text-destructive">Unable to render diagram: {result.message}</p>
          {result.retryable ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => {
                renderCache.delete(mermaidRenderKey(source.trim(), theme));
                setAttempt((attempt) => attempt + 1);
              }}
            >
              Retry
            </Button>
          ) : null}
        </div>
        <pre
          data-thread-find-ignore
          className="mt-2 mb-0 overflow-auto font-mono text-xs whitespace-pre-wrap"
        >
          {source}
        </pre>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <button
        type="button"
        aria-label="Expand diagram"
        className="flex w-full cursor-zoom-in justify-center rounded-md focus-visible:outline-2 focus-visible:outline-ring [&_svg]:h-auto [&_svg]:max-w-full"
        onClick={() => onExpand(mermaidImageUrl(result.svg))}
        dangerouslySetInnerHTML={{ __html: result.svg }}
      />
    </div>
  );
}
