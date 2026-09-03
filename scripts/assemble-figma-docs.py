#!/usr/bin/env python3
"""Assemble crawled Figma Plugin API pages into a single markdown reference."""
import json, re, os

HERE = os.path.dirname(os.path.abspath(__file__))
pages = json.load(open(os.path.join(HERE, 'pages.json'), encoding='utf-8'))

def clean(mdtext):
    mdtext = mdtext.replace('\x00', '')
    mdtext = re.sub(r'\(#[^)\s]*\s*"Direct link[^)]*\)', '', mdtext)
    mdtext = mdtext.replace('\\_', '_')
    mdtext = re.sub(r'^On this page\s*\n+', '', mdtext)
    # remove zero-width anchor links added by docusaurus
    mdtext = mdtext.replace('[\u200b]', '')
    mdtext = re.sub(r'\[(?![^\]]*\]\()[\u200b\u200c\u200d\s]*\]\(#[^)]*\s*"[^"]*"\)', '', mdtext)
    mdtext = re.sub(r'\[([^\]]*)\]\(#[^)]*\s*"Direct link to [^"]*"\)', r'\1', mdtext)
    # make relative doc links absolute
    mdtext = re.sub(r'\]\((/docs/[^)]*)\)', r'](https://developers.figma.com\1)', mdtext)
    # demote headings by one level (h1 -> h2 handled at emit time instead)
    return mdtext.strip()

def key(url):
    """last path segment of the api url"""
    p = url.replace('https://developers.figma.com/docs/plugins/api/', '').strip('/')
    return p

by_key = {key(u): clean(t) for u, t in pages.items()}

# --- classification ---
overview_order = ['global-objects', 'api-reference', 'figma', 'nodes', 'node-properties',
                  'data-types', 'api-errors', 'typings/PluginAPI']
namespace_pages = [k for k in by_key if re.match(r'^figma-[a-zA-Z]', k) and '/properties/' not in k]
figma_props = sorted(k for k in by_key if k.startswith('properties/figma-'))
type_props = sorted(k for k in by_key if k.startswith('properties/') and not k.startswith('properties/figma-'))

# type pages = everything not in the above groups
used = set(overview_order) | set(namespace_pages) | set(figma_props) | set(type_props)
rest = sorted(k for k in by_key if k not in used and '/' not in k)
node_types = [k for k in rest if k.endswith('Node') or k in ('DocumentNode',)]
data_types = [k for k in rest if k not in node_types]

def props_for(type_name):
    pre = 'properties/' + type_name + '-'
    return [k for k in type_props if k.startswith(pre)]

def emit(out, k, heading_level=2):
    t = by_key.get(k)
    if not t:
        return
    # shift headings: page h1 -> h(heading_level), page hN -> h(N+heading_level-1) capped 6
    lines = []
    for ln in t.split('\n'):
        m = re.match(r'^(#{1,6})\s(.*)$', ln)
        if m:
            lvl = min(6, len(m.group(1)) + heading_level - 1)
            lines.append('#' * lvl + ' ' + m.group(2))
        else:
            lines.append(ln)
    body = '\n'.join(lines)
    # ensure the top title exists
    if not body.lstrip().startswith('#'):
        body = '# ' * 0 + f'{"#"*heading_level} {k}\n\n' + body
    out.append(body)
    out.append('')

out = []
title = by_key.get('global-objects', '')

def section(header, intro, keys, emitted_set):
    out.append('# ' + header)
    out.append('')
    if intro:
        out.append(intro)
        out.append('')
    for k in keys:
        if k not in by_key:
            continue
        emitted_set.add(k)
        out.append(f'### <span id="{k.replace("/", "-")}">{k}</span>')
        out.append('')
        emit(out, k, heading_level=4)

# Part 0 — front matter
out.append('# Figma Plugin API — Full Reference (read & write)')
out.append('')
out.append('> Crawled verbatim from https://developers.figma.com/docs/plugins/api/ on 2026-07-32 placeholder.')
out.append('> Organized for MCP-server tooling: file-level operations (`figma.*`), global namespaces,'
           ' node types (scene graph read/write) and data types.')
out.append('')

emitted_set = set()

# Part 1 overview
section('Part 1 — Overview & Conventions', None, overview_order, emitted_set)
# Part 2 figma methods
section('Part 2 — `figma` global object: methods & properties',
        'File-level view/create/update operations. These are the primary read & write entry points.',
        figma_props, emitted_set)
# Part 3 namespaces
section('Part 3 — Global namespaces',
        '`figma.ui`, `figma.variables`, `figma.viewport`, `figma.clientStorage`, …',
        namespace_pages, emitted_set)
# Part 4 node types
section('Part 4 — Node types (scene graph)',
        'Each node page lists all readable/writable properties of that node type; '
        'detail sub-pages follow each type.',
        [], emitted_set)
for k in node_types:
    emitted_set.add(k)
    out.append(f'### <span id="{k}">{k}</span>')
    out.append('')
    emit(out, k, 4)
    for pk in props_for(k):
        emitted_set.add(pk)
        pname = pk[len('properties/'):]
        out.append(f'#### Detail: `{pname}`')
        out.append('')
        emit(out, pk, 6)
# Part 5 data types
section('Part 5 — Data types & interfaces',
        'Paint, Transform, Variable, Style, events, etc.',
        data_types, emitted_set)
# Part 6 remaining type property detail pages not attached to node types
orphan_props = [k for k in type_props if not any(k.startswith('properties/' + n + '-') for n in node_types)]
section('Part 6 — Property detail pages (non-node types)', None, orphan_props, emitted_set)

dest = os.path.join(HERE, '..', 'docs', 'figma-plugin-api-reference.md')
os.makedirs(os.path.dirname(dest), exist_ok=True)
text = '\n'.join(out)
# fix placeholder date
text = text.replace('on 2026-07-32 placeholder', 'from the live sitemap (441 pages)')
open(dest, 'w', encoding='utf-8', newline='\n').write(text)
print(dest, len(text), 'chars,', text.count('\n'), 'lines')
missing = set(by_key) - emitted_set
if missing:
    print('NOT EMITTED:', sorted(missing))
else:
    print('coverage: all', len(by_key), 'pages emitted')
