import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import bash from 'highlight.js/lib/languages/bash';
import json from 'highlight.js/lib/languages/json';
import python from 'highlight.js/lib/languages/python';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import sql from 'highlight.js/lib/languages/sql';
import diff from 'highlight.js/lib/languages/diff';
import yaml from 'highlight.js/lib/languages/yaml';
import { esc } from '../util.ts';
import { linkRefs, type RefIndex } from './refs.ts';

for (const [name, language] of Object.entries({ javascript, typescript, bash, json, python, css, xml, sql, diff, yaml })) {
  hljs.registerLanguage(name, language);
}

/**
 * Highlighted HTML for a snippet in one of the registered languages, or null
 * when the language is unknown or the text is too big to be worth it. The
 * file viewer (kinds/file.ts) uses the same set so a `.ts` looks the same
 * in a transcript and on its own.
 */
export function highlight(code: string, language: string | null, maxChars = 300_000): string | null {
  if (!language || !hljs.getLanguage(language) || code.length > maxChars) return null;
  try { return hljs.highlight(code, { language, ignoreIllegals: true }).value; } catch { return null; }
}

/** Shared transcript renderer. CLI output is Markdown, never trusted HTML. */
const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true, typographer: false });
markdown.renderer.rules.fence = (tokens, index) => {
  const token = tokens[index]!;
  const language = token.info.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  let code = esc(token.content);
  // Large or unknown snippets stay readable without expensive guessing.
  if (language && hljs.getLanguage(language) && token.content.length <= 16_000) {
    try { code = hljs.highlight(token.content, { language, ignoreIllegals: true }).value; } catch { /* plain text */ }
  }
  return `<pre class="talk__pre"${language ? ` data-language="${esc(language)}"` : ''}><code class="hljs">${code}</code></pre>\n`;
};
markdown.renderer.rules.code_block = (tokens, index) => `<pre class="talk__pre"><code>${esc(tokens[index]!.content)}</code></pre>\n`;

for (const [rule, className] of Object.entries({ table_open: 'talk__table', heading_open: 'talk__h', bullet_list_open: 'talk__ul', ordered_list_open: 'talk__ul', blockquote_open: 'talk__quote' })) {
  markdown.renderer.rules[rule] = (tokens, index, options, _env, renderer) => {
    tokens[index]!.attrJoin('class', className);
    return renderer.renderToken(tokens, index, options);
  };
}

const external = (href: string) => /^(?:https?:\/\/|mailto:)/i.test(href);
markdown.renderer.rules.link_open = (tokens, index, options, _env, renderer) => {
  const token = tokens[index]!;
  const href = String(token.attrGet('href') ?? '');
  // Local file references have no browser route. Show their full target on hover.
  if (!external(href)) {
    const close = tokens.slice(index + 1).find((t) => t.type === 'link_close');
    if (close) close.meta = { localPath: true };
    return `<span class="talk__file" title="${esc(href)}">`;
  }
  token.attrSet('target', '_blank');
  token.attrSet('rel', 'noopener noreferrer');
  return renderer.renderToken(tokens, index, options);
};
markdown.renderer.rules.link_close = (tokens, index) => tokens[index]!.meta?.localPath ? '</span>' : '</a>';
// Transcripts may mention remote images; load them only when the reader opens the link.
markdown.renderer.rules.image = (tokens, index) => {
  const token = tokens[index]!;
  const src = String(token.attrGet('src') ?? '');
  const label = esc(token.content || 'Image');
  return external(src) ? `<a href="${esc(src)}" target="_blank" rel="noopener noreferrer">${label}</a>` : `<span class="talk__file" title="${esc(src)}">${label}</span>`;
};

/**
 * Kept as mdLite for existing callers; supports Markdown tables and nested lists.
 * With `refs`, every callsign, agent id and squad name in the prose becomes a
 * link that flies the camera there (see refs.ts) — CAPCOM's window passes the
 * fleet; a plain transcript passes nothing.
 */
export function mdLite(raw: string, refs?: RefIndex): string {
  const html = markdown.render(raw.replace(/\r\n?/g, '\n'));
  return refs ? linkRefs(html, refs) : html;
}
