// A small Markdown-to-HTML converter for the guides in docs/, so they ship as
// web pages people can open with a double-click (and the user guide is served
// by the board itself). It covers what the guides use: headings, paragraphs,
// lists, tables, fenced code, block quotes, rules, links, `code`, **bold**,
// *italic* and <kbd>. Everything else is escaped. Build-time only.

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const slug = (text) =>
  text
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[`*_]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s/g, '-');

/** Inline markup. `link` rewrites hrefs (e.g. .md → .html). */
function inline(text, link) {
  const codes = [];
  let s = text.replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(esc(c)) - 1}\u0000`);
  s = esc(s);
  s = s.replace(/&lt;(\/?)kbd&gt;/g, '<$1kbd>');
  s = s.replace(/&lt;(https?:\/\/[^\s&]+)&gt;/g, (_, u) => `<a href="${u}">${u}</a>`);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, href) => `<a href="${esc(link(href.replace(/&amp;/g, '&')))}">${t}</a>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\w)/g, '$1<em>$2</em>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
}

/**
 * Convert Markdown to an HTML fragment.
 * Returns { html, title, headings } where headings are the ## level-2 entries for a contents list.
 */
export function markdownToHtml(md, { link = (h) => h } = {}) {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  const headings = [];
  let title = '';
  let i = 0;

  const isBlockStart = (l) => /^(#{1,6} |```|>|\s*([-*]|\d+\.) |\|)/.test(l) || /^-{3,}\s*$/.test(l);

  const indentOf = (l) => /^(\s*)/.exec(l)[1].length;
  const ITEM = /^(\s*)([-*]|\d+\.) (.*)$/;

  /** A list: each item's own lines (indented under it) are rendered recursively. */
  function list(indent) {
    const ordered = /^\s*\d+\. /.test(lines[i]);
    const items = [];
    while (i < lines.length) {
      const m = ITEM.exec(lines[i]);
      if (!m || m[1].length !== indent || /^\d/.test(m[2]) !== ordered) break;
      const contentIndent = indent + m[2].length + 1;
      const body = [m[3]];
      i++;
      while (i < lines.length) {
        const l = lines[i];
        if (l.trim() === '') {
          // a blank line continues the item only if indented content follows
          let j = i;
          while (j < lines.length && lines[j].trim() === '') j++;
          if (j < lines.length && indentOf(lines[j]) >= Math.min(contentIndent, indent + 2)) {
            for (; i < j; i++) body.push('');
            continue;
          }
          break;
        }
        if (indentOf(l) > indent) body.push(l.slice(Math.min(indentOf(l), contentIndent)));
        else if (!isBlockStart(l) && body[body.length - 1] !== '') body.push(l.trim()); // lazy continuation
        else break;
        i++;
      }
      const simple = body.length === 1 || body.every((b) => b !== '' && !isBlockStart(b));
      items.push(simple ? inline(body.map((b) => b.trim()).join(' '), link) : markdownToHtml(body.join('\n'), { link }).html.replace(/^<p>([\s\S]*?)<\/p>/, '$1'));
      while (i < lines.length && lines[i].trim() === '' && i + 1 < lines.length && ITEM.test(lines[i + 1]) && indentOf(lines[i + 1]) === indent) i++;
    }
    const tag = ordered ? 'ol' : 'ul';
    return `<${tag}>${items.map((it) => `<li>${it}</li>`).join('')}</${tag}>`;
  }

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      i++;
      continue;
    }
    let m;
    if ((m = /^(#{1,6}) (.*)$/.exec(line))) {
      const level = m[1].length;
      const id = slug(m[2]);
      if (level === 1 && !title) title = m[2].replace(/[`*]/g, '');
      if (level === 2) headings.push({ id, text: m[2].replace(/[`*]/g, '') });
      out.push(`<h${level} id="${id}">${inline(m[2], link)}</h${level}>`);
      i++;
    } else if ((m = /^```(\w*)/.exec(line))) {
      const body = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++]);
      i++;
      out.push(`<pre${m[1] ? ` data-lang="${m[1]}"` : ''}><code>${esc(body.join('\n'))}</code></pre>`);
    } else if (/^-{3,}\s*$/.test(line)) {
      out.push('<hr>');
      i++;
    } else if (/^>/.test(line)) {
      const body = [];
      while (i < lines.length && /^>/.test(lines[i])) body.push(lines[i++].replace(/^> ?/, ''));
      out.push(`<blockquote>${markdownToHtml(body.join('\n'), { link }).html}</blockquote>`);
    } else if (/^\s*([-*]|\d+\.) /.test(line)) {
      out.push(list(/^(\s*)/.exec(line)[1].length));
    } else if (/^\|/.test(line)) {
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) rows.push(lines[i++]);
      const cells = (r) =>
        r
          .replace(/^\||\|\s*$/g, '')
          .split(/(?<!\\)\|/)
          .map((c) => c.trim().replace(/\\\|/g, '|'));
      const head = cells(rows[0]);
      const body = rows.slice(/^\|[\s:|-]+\|?\s*$/.test(rows[1] ?? '') ? 2 : 1).map(cells);
      const hasHead = head.some((c) => c !== '');
      out.push(
        `<div class="table-wrap"><table>${hasHead ? `<thead><tr>${head.map((c) => `<th>${inline(c, link)}</th>`).join('')}</tr></thead>` : ''}<tbody>${body
          .map((r) => `<tr>${r.map((c) => `<td>${inline(c, link)}</td>`).join('')}</tr>`)
          .join('')}</tbody></table></div>`,
      );
    } else {
      const para = [];
      while (i < lines.length && lines[i].trim() !== '' && !isBlockStart(lines[i])) para.push(lines[i++].trim());
      if (!para.length) para.push(lines[i++].trim()); // a line that only looked like a block start
      out.push(`<p>${inline(para.join(' '), link)}</p>`);
    }
  }
  return { html: out.join('\n'), title, headings };
}

const CSS = `
:root{color-scheme:light dark;--bg:#fff;--fg:#1f2937;--muted:#5b6472;--line:#d8dde5;--soft:#f3f5f8;--accent:#1d4ed8}
@media (prefers-color-scheme:dark){:root{--bg:#14171c;--fg:#e5e7eb;--muted:#a3abb8;--line:#343a44;--soft:#1d2128;--accent:#8ab4ff}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 "Segoe UI",system-ui,-apple-system,sans-serif}
main{max-width:52rem;margin:0 auto;padding:2rem 1rem 4rem}
nav.top{font-size:.9rem;color:var(--muted);display:flex;gap:1rem;flex-wrap:wrap;border-bottom:1px solid var(--line);padding-bottom:.75rem;margin-bottom:1.5rem}
nav.top a{color:var(--muted)}nav.top a[aria-current]{color:var(--fg);font-weight:600;text-decoration:none}
h1{font-size:1.9rem;line-height:1.2;margin:.2em 0 .6em}h2{font-size:1.35rem;margin:2.2em 0 .6em;padding-top:.6em;border-top:1px solid var(--line)}h3{font-size:1.1rem;margin:1.6em 0 .4em}
a{color:var(--accent)}
code{font:.88em/1.4 Consolas,"Cascadia Mono",ui-monospace,monospace;background:var(--soft);padding:.1em .35em;border-radius:4px;overflow-wrap:anywhere}
pre{background:var(--soft);border:1px solid var(--line);border-radius:8px;padding:.8rem 1rem;overflow-x:auto}pre code{background:none;padding:0;overflow-wrap:normal}
kbd{font:.82em Consolas,ui-monospace,monospace;border:1px solid var(--line);border-bottom-width:2px;border-radius:4px;padding:.05em .4em;background:var(--soft);white-space:nowrap}
.table-wrap{overflow-x:auto;margin:1rem 0}table{border-collapse:collapse;width:100%;font-size:.95rem}th,td{text-align:left;vertical-align:top;padding:.45rem .6rem;border-bottom:1px solid var(--line)}th{background:var(--soft)}
blockquote{margin:1rem 0;padding:.6rem 1rem;border-left:4px solid var(--accent);background:var(--soft);border-radius:0 8px 8px 0}blockquote p{margin:.3em 0}
.contents{background:var(--soft);border-radius:8px;padding:.6rem 1rem;margin-bottom:1.5rem}.contents ol{margin:.3rem 0;padding-left:1.4rem;columns:2;column-gap:2rem}@media (max-width:640px){.contents ol{columns:1}}
li{margin:.2em 0}.contents li{break-inside:avoid;margin:0 0 .25em}
@media print{nav.top,.contents{display:none}h2{break-after:avoid}pre,table{break-inside:avoid}}
`;

/** A complete, self-contained page (inline CSS, no scripts) for one guide. */
export function guidePage(md, { link, nav = [], current = '', footer = '' } = {}) {
  const { html, title, headings } = markdownToHtml(md, { link });
  const contents =
    headings.length >= 4
      ? `<div class="contents"><strong>On this page</strong><ol>${headings.map((h) => `<li><a href="#${h.id}">${esc(h.text.replace(/^\d+\.\s+/, ''))}</a></li>`).join('')}</ol></div>`
      : '';
  // the contents list goes right after the first heading and its introduction
  const firstH2 = html.indexOf('<h2');
  const body = contents && firstH2 > 0 ? html.slice(0, firstH2) + contents + html.slice(firstH2) : html;
  const navHtml = nav.length
    ? `<nav class="top" aria-label="Guides">${nav.map((n) => `<a href="${n.href}"${n.href === current ? ' aria-current="page"' : ''}>${esc(n.label)}</a>`).join('')}</nav>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}: Engineering Board</title>
<style>${CSS.trim()}</style>
</head>
<body>
<main>
${navHtml}
${body}
${footer}
</main>
</body>
</html>
`;
}
