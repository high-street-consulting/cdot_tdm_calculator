// Minimal Markdown renderer with no runtime dependency.
//
// Covers the subset the strategy catalog uses: paragraphs, headings, ordered
// and unordered lists, plus inline **bold**, *italic*, `code`, and
// [links](https://…). External links open in a new tab; in-app links whose URL
// contains a hash route (#/…) navigate in place via the HashRouter, so the user
// stays in the same window. HTML comments are stripped.
// Content is first-party (authored in this repo's YAML), so there is no
// dangerouslySetInnerHTML and no need for a full CommonMark parser; if the
// content grows to need tables/footnotes/etc., swap this for a build-time
// Markdown→HTML step rather than a client-side dependency.

import { createElement, type ReactNode } from "react";

interface MarkdownProps {
  children?: string;
  /** Extra class on the wrapper (the wrapper always carries `md`). */
  className?: string;
}

type Block =
  | { type: "heading"; level: number; text: string }
  | { type: "p"; text: string }
  | { type: "ul"; items: string[] }
  | { type: "ol"; items: string[] };

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const UL_RE = /^\s*[-*]\s+/;
const OL_RE = /^\s*\d+\.\s+/;

function parseBlocks(text: string): Block[] {
  const lines = text.split("\n");
  const blocks: Block[] = [];
  let i = 0;

  const gatherItems = (re: RegExp): string[] => {
    const items: string[] = [];
    while (i < lines.length && re.test(lines[i])) {
      let item = lines[i].replace(re, "");
      i++;
      // Fold indented continuation lines into the current item.
      while (
        i < lines.length &&
        lines[i].trim() &&
        /^\s+/.test(lines[i]) &&
        !UL_RE.test(lines[i]) &&
        !OL_RE.test(lines[i])
      ) {
        item += " " + lines[i].trim();
        i++;
      }
      items.push(item);
    }
    return items;
  };

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const h = HEADING_RE.exec(line);
    if (h) {
      blocks.push({ type: "heading", level: h[1].length, text: h[2] });
      i++;
      continue;
    }
    if (UL_RE.test(line)) {
      blocks.push({ type: "ul", items: gatherItems(UL_RE) });
      continue;
    }
    if (OL_RE.test(line)) {
      blocks.push({ type: "ol", items: gatherItems(OL_RE) });
      continue;
    }
    // Paragraph: fold soft-wrapped lines together until a blank line or the
    // start of a heading/list.
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !HEADING_RE.test(lines[i]) &&
      !UL_RE.test(lines[i]) &&
      !OL_RE.test(lines[i])
    ) {
      para.push(lines[i].trim());
      i++;
    }
    blocks.push({ type: "p", text: para.join(" ") });
  }
  return blocks;
}

const INLINE = [
  { re: /`([^`]+)`/, node: (m: RegExpExecArray, k: string) => <code key={k}>{m[1]}</code> },
  {
    re: /\[([^\]]+)\]\(([^)\s]+)\)/,
    node: (m: RegExpExecArray, k: string) => {
      // In-app links carry a hash route (#/strategies/…); strip any absolute
      // prefix so the href is relative and the HashRouter handles it client-
      // side in the same window. Everything else is external → new tab.
      const hashAt = m[2].indexOf("#/");
      if (hashAt !== -1) {
        return (
          <a key={k} href={m[2].slice(hashAt)}>
            {renderInline(m[1], k)}
          </a>
        );
      }
      return (
        <a key={k} href={m[2]} target="_blank" rel="noopener noreferrer">
          {renderInline(m[1], k)}
        </a>
      );
    },
  },
  {
    re: /\*\*([^*]+)\*\*/,
    node: (m: RegExpExecArray, k: string) => <strong key={k}>{renderInline(m[1], k)}</strong>,
  },
  {
    re: /\*([^*]+)\*/,
    node: (m: RegExpExecArray, k: string) => <em key={k}>{renderInline(m[1], k)}</em>,
  },
] as const;

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  let n = 0;
  while (rest.length) {
    let best: { start: number; m: RegExpExecArray; make: (typeof INLINE)[number]["node"] } | null = null;
    for (const p of INLINE) {
      const m = p.re.exec(rest);
      if (m && (best === null || m.index < best.start)) {
        best = { start: m.index, m, make: p.node };
      }
    }
    if (!best) {
      out.push(rest);
      break;
    }
    if (best.start > 0) out.push(rest.slice(0, best.start));
    out.push(best.make(best.m, `${keyPrefix}-${n++}`));
    rest = rest.slice(best.start + best.m[0].length);
  }
  return out;
}

export function Markdown({ children, className }: MarkdownProps) {
  const text = (children ?? "").replace(/\r\n/g, "\n").replace(/<!--[\s\S]*?-->/g, "").trim();
  if (!text) return null;
  const blocks = parseBlocks(text);
  return (
    <div className={className ? `md ${className}` : "md"}>
      {blocks.map((b, i) => {
        const key = `b${i}`;
        switch (b.type) {
          case "heading":
            return createElement(
              `h${Math.min(6, b.level)}`,
              { key },
              renderInline(b.text, key),
            );
          case "ul":
            return (
              <ul key={key}>
                {b.items.map((it, j) => (
                  <li key={j}>{renderInline(it, `${key}-${j}`)}</li>
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol key={key}>
                {b.items.map((it, j) => (
                  <li key={j}>{renderInline(it, `${key}-${j}`)}</li>
                ))}
              </ol>
            );
          default:
            return <p key={key}>{renderInline(b.text, key)}</p>;
        }
      })}
    </div>
  );
}
