#!/usr/bin/env python3
"""The API's doc (public/api/v1/doc.md) as an HTML page, served at /api/v1/doc
beside the Markdown (vite.config.js adds it to the app's static assets).

Usage: render.py <doc.md> <doc.html> [--url URL]

Laid out as the pastebin's Markdown pages are (pb's /a/, e.g.
https://shz.al/a/yShz): GitHub's Markdown styles, a table of contents of the
h2-h4 headings beside the text on wide screens, which marks the section being
read, an anchor by each heading, and code blocks with a gutter of line
numbers, highlighted here (Pygments) in the colors pb's highlight.js theme
gives (GitHub's). The page needs nothing but GitHub's stylesheet; the same
Markdown gives the same page, byte for byte. Needs the markdown and pygments
packages.
"""

import argparse
import html
import re
from pathlib import Path

import markdown

URL = 'https://map.shz.al/api/v1/doc'
MARKDOWN_URL = '/api/v1/doc.md'
DESCRIPTION_LIMIT = 200
TOC_MIN_DEPTH = 2
TOC_MAX_DEPTH = 4
TOC_THRESHOLD = 3
# Pygments' token classes in GitHub's light colors, as pb's highlight.js
# theme (highlight-theme-light.css) has them
TOKEN_COLORS = {
    '#d73a49': ['k', 'kd', 'kn', 'kp', 'kr', 'kt', 'ow'],  # keyword
    '#6f42c1': ['nf', 'nc', 'fm'],  # entity
    '#005cc5': ['kc', 'm', 'mb', 'mf', 'mh', 'mi', 'mo', 'il', 'nt', 'na', 'no', 'nv', 'o'],  # constant
    '#032f62': ['s', 's1', 's2', 'sa', 'sb', 'sc', 'sd', 'se', 'sh', 'si', 'sr', 'ss', 'sx', 'dl'],  # string
    '#e36209': ['nb', 'bp'],  # variable
    '#6a737d': ['c', 'c1', 'cm', 'cp', 'cs', 'ch', 'cpf'],  # comment
    '#22863a': ['nn', 'gi'],  # entity tag
    '#b31d28': ['err', 'gd'],
}

PAGE_STYLES = '''
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji"; }
  .page { display: grid; grid-template-columns: minmax(0, 1fr); gap: 2rem; max-width: 1200px; margin: 2rem auto; padding: 0 1rem; box-sizing: border-box; }
  .page > article { min-width: 0; }
  @media (min-width: 1024px) { .page.has-toc { grid-template-columns: 240px minmax(0, 1fr); } }
  .toc { font-size: 0.9em; line-height: 1.5; }
  @media (min-width: 1024px) { .toc { position: sticky; top: 1rem; align-self: start; max-height: calc(100vh - 2rem); overflow-y: auto; } }
  .toc ol { list-style: none; padding-left: 1em; margin: 0; }
  .toc > ol { padding-left: 0; }
  .toc li { margin: 0; }
  .toc a { display: block; padding: 0.2rem 0 0.2rem 0.5rem; color: #57606a; text-decoration: none; border-left: 2px solid transparent; overflow-wrap: break-word; }
  .toc a:hover { color: #0969da; }
  .toc a.active { color: #0969da; border-left-color: #0969da; background: rgba(9, 105, 218, 0.06); }
  .toc .toc-source { margin-top: 0.75rem; padding-left: 0.5rem; }
  .markdown-body :is(h1, h2, h3, h4, h5, h6) .header-anchor { opacity: 0; margin-left: -0.8em; padding-right: 0.2em; color: #57606a; text-decoration: none; font-weight: normal; }
  .markdown-body :is(h1, h2, h3, h4, h5, h6):hover .header-anchor,
  .markdown-body .header-anchor:focus { opacity: 1; }
  .markdown-body :is(h2, h3, h4) { scroll-margin-top: 1rem; }
  .markdown-body table { display: block; overflow-x: auto; }
  /* Fenced code: a gutter of line numbers (CSS counters) beside the code */
  .markdown-body .code-block { display: grid; grid-template-columns: auto minmax(0, 1fr); margin: 1em 0; border: 1px solid #d0d7de; border-radius: 6px; background: #f6f8fa; overflow: hidden; font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; font-size: 85%; line-height: 1.45; }
  .markdown-body .code-block > pre { grid-column: 2; margin: 0; padding: 12px 16px; overflow-x: auto; background: transparent; font: inherit; border: 0; border-radius: 0; }
  .markdown-body .code-block > pre > code { background: transparent; padding: 0; font: inherit; border-radius: 0; white-space: pre; }
  .markdown-body .code-block > .line-number-rows { grid-column: 1; padding: 12px 8px 12px 12px; border-right: 1px solid #d0d7de; color: #6e7681; user-select: none; counter-reset: linenumber; }
  .line-number-rows > span::before { content: counter(linenumber); counter-increment: linenumber; display: block; text-align: right; min-width: 1.5em; }
  .markdown-body .code-block code { color: #24292e; }
''' + ''.join(f"  {', '.join(f'.code-block .{c}' for c in classes)} {{ color: {color}; }}\n"
              for color, classes in TOKEN_COLORS.items())

# Marks the table of contents' entry of the section being read (pb's
# scrollSpy.ts): the last heading above the top of the window, or the one the
# address names right after following a link.
SCROLL_SPY = '''
(() => {
  const links = new Map();
  for (const a of document.querySelectorAll('.toc a[href^="#"]')) links.set(decodeURIComponent(a.hash.slice(1)), a);
  const headings = [...links.keys()].map((id) => document.getElementById(id)).filter(Boolean);
  if (!headings.length) return;
  let active, lockUntil = 0, ticking = false;
  const setActive = (link) => {
    if (link === active) return;
    active?.classList.remove('active');
    link?.classList.add('active');
    active = link;
  };
  const update = () => {
    if (Date.now() < lockUntil) return;
    let current = headings[0];
    for (const h of headings) {
      if (h.getBoundingClientRect().top <= 80) current = h;
      else break;
    }
    setActive(links.get(current.id));
  };
  const byHash = () => {
    const link = links.get(decodeURIComponent(location.hash.slice(1)));
    if (!link) return false;
    setActive(link);
    lockUntil = Date.now() + 800;
    return true;
  };
  const onScroll = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => { ticking = false; update(); });
  };
  addEventListener('scroll', onScroll, { passive: true });
  addEventListener('resize', onScroll, { passive: true });
  addEventListener('hashchange', byHash);
  if (!byHash()) update();
})();
'''

CODE_BLOCK = re.compile(r'<div class="highlight"><pre><span></span><code>(.*?)</code></pre></div>', re.S)
TAG = re.compile(r'<[^>]+>')


def plain(fragment):
    """Text of an HTML fragment"""
    return html.unescape(TAG.sub('', fragment)).strip()


def code_blocks(body):
    """Pygments' blocks laid out with a gutter of their line numbers"""

    def block(match):
        code = match.group(1)
        lines = code.rstrip('\n').count('\n') + 1
        gutter = '<span></span>' * lines
        return (f'<div class="code-block"><span class="line-number-rows" aria-hidden="true">{gutter}</span>'
                f'<pre><code>{code.rstrip(chr(10))}</code></pre></div>')

    return CODE_BLOCK.sub(block, body)


def toc_entries(tokens):
    """The headings between TOC_MIN_DEPTH and TOC_MAX_DEPTH, in order: (depth, id, text)"""
    out = []
    for token in tokens:
        if TOC_MIN_DEPTH <= token['level'] <= TOC_MAX_DEPTH:
            out.append((token['level'], token['id'], plain(token['name'])))
        out += toc_entries(token['children'])
    return out


def toc_label(text):
    """A heading's entry: an endpoint without the GET every one has, its
    path breaking only after a slash"""
    return html.escape(re.sub(r'^GET ', '', text)).replace('/', '/<wbr>')


def render_toc(entries):
    """Nested lists of the headings, as pb's renderToc; empty for a few"""
    if len(entries) < TOC_THRESHOLD:
        return ''
    out, open_depths = [], []
    for depth, anchor, text in entries:
        while open_depths and open_depths[-1] > depth:
            out.append('</li></ol>')
            open_depths.pop()
        if open_depths and open_depths[-1] == depth:
            out.append('</li>')
        else:
            out.append('<ol>')
            open_depths.append(depth)
        out.append(f'<li><a href="#{html.escape(anchor)}">{toc_label(text)}</a>')
    out += ['</li></ol>'] * len(open_depths)
    return ('<nav class="toc" aria-label="Table of contents">' + ''.join(out)
            + f'<div class="toc-source"><a href="{MARKDOWN_URL}">Markdown</a></div></nav>')


def title_and_description(body):
    """The first h1's text, and the first paragraph's, cut short"""
    title = re.search(r'<h1[^>]*>(.*?)</h1>', body, re.S)
    paragraph = re.search(r'<p>(.*?)</p>', body, re.S)
    text = re.sub(r'\s+', ' ', plain(paragraph.group(1))) if paragraph else ''
    if len(text) > DESCRIPTION_LIMIT:
        text = text[:DESCRIPTION_LIMIT - 1].rstrip() + '…'
    return (plain(title.group(1)).lstrip('#').strip() if title else 'API'), text


def render(text, url=URL):
    md = markdown.Markdown(extensions=['tables', 'fenced_code', 'codehilite', 'toc', 'sane_lists'], extension_configs={
        'codehilite': {'css_class': 'highlight', 'guess_lang': False},
        # An anchor before each heading, shown on hover
        'toc': {'permalink': '#', 'permalink_class': 'header-anchor', 'permalink_title': 'Link to this section',
                'permalink_leading': True},
    })
    body = code_blocks(md.convert(text))
    toc = render_toc(toc_entries(md.toc_tokens))
    title, description = title_and_description(body)
    e = html.escape
    return f'''<!DOCTYPE html>
<html lang="en" class="light">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{e(title)}</title>
  <meta name="description" content="{e(description)}">
  <link rel="canonical" href="{e(url)}">
  <meta property="og:url" content="{e(url)}">
  <link rel="alternate" type="text/markdown" href="{MARKDOWN_URL}">
  <link rel="stylesheet" href="https://pages.github.com/assets/css/style.css">
  <style>{PAGE_STYLES}  </style>
</head>
<body>
<div class="page{' has-toc' if toc else ''}">
{toc}
<article class="px-3 markdown-body">
{body}
</article>
</div>
<script>{SCROLL_SPY}</script>
</body>
</html>
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('doc', help='the Markdown')
    parser.add_argument('out', help='where to write the page')
    parser.add_argument('--url', default=URL, help=f"the page's address (default: {URL})")
    args = parser.parse_args()
    page = render(Path(args.doc).read_text(encoding='utf-8'), args.url)
    Path(args.out).write_text(page, encoding='utf-8')
    print(f'{args.out}: {len(page.encode()) / 1e3:.0f} kB')


if __name__ == '__main__':
    main()
