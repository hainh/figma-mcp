#!/usr/bin/env python3
"""Crawl Figma Plugin API docs from developers.figma.com into one markdown file."""
import re, os, sys, html, time, json
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from markdownify import markdownify as md

CACHE = os.path.join(os.path.dirname(__file__), 'cache')
os.makedirs(CACHE, exist_ok=True)

BASE = 'https://developers.figma.com'
SITEMAP = BASE + '/sitemap.xml'

def slugify(url):
    return url.replace('https://developers.figma.com/docs/plugins/api/', '').strip('/').replace('/', '__') or 'index'

def fetch(url, retries=3):
    cache_file = os.path.join(CACHE, slugify(url) + '.html')
    if os.path.exists(cache_file) and os.path.getsize(cache_file) > 200:
        return open(cache_file, encoding='utf-8').read()
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (docs-crawler)'})
            with urllib.request.urlopen(req, timeout=30) as r:
                data = r.read().decode('utf-8', 'replace')
            with open(cache_file, 'w', encoding='utf-8') as f:
                f.write(data)
            return data
        except Exception as e:
            if i == retries - 1:
                sys.stderr.write(f'FAIL {url}: {e}\n')
                return None
            time.sleep(2 * (i + 1))

def extract_article(htmltext):
    m = re.search(r'<article[^>]*>(.*?)</article>', htmltext, re.S)
    if not m:
        return None
    s = m.group(1)
    # drop nav / breadcrumbs / pagination / feedback widgets
    s = re.sub(r'<nav[^>]*>.*?</nav>', '', s, flags=re.S)
    s = re.sub(r'<aside[^>]*>.*?</aside>', '', s, flags=re.S)
    for cls in ('theme-doc-breadcrumbs', 'pagination-nav', 'doc-feedback-wrapper',
                'theme-edit-this-page', 'docusaurus-mt-lg-margin'):
        s = re.sub(r'<[^>]*class="[^"]*%s[^"]*"[^>]*>.*?</[^>]+>' % cls, '', s, flags=re.S)
    s = re.sub(r'<!--.*?-->', '', s, flags=re.S)
    # pre/code -> fenced blocks markdownify handles poorly with spans
    def fix_pre(mm):
        lang = 'js' if 'language-' in mm.group(1) else ''
        mlang = re.search(r'language-(\w+)', mm.group(1))
        if mlang: lang = mlang.group(1)
        code = re.sub(r'<[^>]+>', '', mm.group(2))
        code = html.unescape(code)
        return '\n```%s\n%s\n```\n' % (lang, code.strip('\n'))
    s = re.sub(r'<pre([^>]*)>(.*?)</pre>', fix_pre, s, flags=re.S)
    return s

def to_md(s):
    out = md(s, heading_style='ATX', bullets='-', code_language='')
    out = re.sub(r'\n{3,}', '\n\n', out)
    # strip image links artifacts
    out = re.sub(r'!\[[^\]]*\]\([^)]*\)', '', out)
    return out.strip()

def main():
    urls = [u for u in re.findall(r'<loc>([^<]+)</loc>', fetch(SITEMAP)) if '/docs/plugins/api/' in u]
    urls = sorted(set(urls))
    print(f'{len(urls)} pages to crawl', flush=True)
    results = {}
    with ThreadPoolExecutor(max_workers=8) as ex:
        futs = {ex.submit(fetch, u): u for u in urls}
        for i, f in enumerate(as_completed(futs), 1):
            u = futs[f]
            h = f.result()
            if h:
                a = extract_article(h)
                if a:
                    results[u] = to_md(a)
            if i % 50 == 0:
                print(f'  {i}/{len(urls)}', flush=True)
    with open(os.path.join(CACHE, '..', 'pages.json'), 'w', encoding='utf-8') as f:
        json.dump(results, f)
    print(f'saved {len(results)} pages -> pages.json', flush=True)

if __name__ == '__main__':
    main()
