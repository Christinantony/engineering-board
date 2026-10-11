// The guides in docs/ as web pages. Built into dist/app/web/guides/ so the board
// serves them to everyone (http://<host>:8080/guides/user-guide.html), and copied
// into the package's guides/ folder so they open with a double-click too.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { guidePage } from './markdown.mjs';

export const GUIDES = [
  { src: 'docs/USER-GUIDE.md', out: 'user-guide.html', label: 'User guide' },
  { src: 'docs/ADMIN-GUIDE.md', out: 'admin-guide.html', label: 'Admin guide' },
  { src: 'docs/INSTALL.md', out: 'install.html', label: 'Install and update' },
  { src: 'docs/TROUBLESHOOTING.md', out: 'troubleshooting.html', label: 'Troubleshooting' },
  { src: 'docs/FOR-IT.md', out: 'for-it.html', label: 'For IT' },
];

const byFile = new Map(GUIDES.map((g) => [g.src.replace(/^docs\//, ''), g.out]));

/** INSTALL.md#x → install.html#x; links that point elsewhere are left alone. */
export function guideLink(href) {
  const [file, hash] = href.split('#');
  const out = byFile.get(file);
  return out ? out + (hash ? `#${hash}` : '') : href;
}

export function writeGuides(outDir, version) {
  mkdirSync(outDir, { recursive: true });
  const nav = GUIDES.map((g) => ({ href: g.out, label: g.label }));
  for (const g of GUIDES) {
    const md = readFileSync(g.src, 'utf8');
    const html = guidePage(md, {
      link: guideLink,
      nav,
      current: g.out,
      footer: `<p style="margin-top:3rem;color:var(--muted);font-size:.85rem">Engineering Board ${version}</p>`,
    });
    writeFileSync(join(outDir, g.out), html);
  }
  return GUIDES.map((g) => g.out);
}
