#!/usr/bin/env python3
"""Render the same reviewed answers for people and repository readers. No network."""
import argparse, hashlib, html, json
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]

def render(root=ROOT, check=False):
    data = json.loads((root / 'docs/discovery/answers.json').read_text())
    version = json.loads((root / 'marketing-site/release.json').read_text())['version']
    # Same ?v= cache-busting stamp as scripts/build-site-languages.ts, so versioned assets can be immutable.
    stamp = lambda name: '/' + name + '?v=' + hashlib.sha256((root / 'marketing-site' / name).read_bytes()).hexdigest()[:12]
    outputs = {}
    for lang in ('en', 'ru'):
        title = 'Is Qoopia right for you?' if lang == 'en' else 'Подходит ли вам Qoopia?'
        route = '/understand' if lang == 'en' else '/ru/understand'
        home = '/' if lang == 'en' else '/ru/'  # the Russian site copy lives under /ru/ (scripts/build-site-languages.ts)
        locale, other_locale = ('en_US', 'ru_RU') if lang == 'en' else ('ru_RU', 'en_US')
        esc = html.escape
        sections, markdown = [], [f'# {title}', f"Reviewed: {data['reviewed_date']} for Qoopia {version}."]
        for row in data['items']:
            text = row[lang]
            refs = []
            for source in row['sources']:
                if not (root / source).is_file():
                    raise ValueError(f'Missing authority: {source}')
                url = 'https://github.com/qoopia/qoopia-source/blob/main/' + source
                refs.append(f'<a href="{esc(url)}">{esc(source)}</a>')
            label = 'Implementation and documentation' if lang == 'en' else 'Код и документация'
            sections.append(f'<section id="{row["id"]}"><h2>{esc(text["question"])}</h2><p>{esc(text["answer"])}</p><details><summary>{label}</summary><ul>' + ''.join(f'<li>{x}</li>' for x in refs) + '</ul></details></section>')
            markdown += ['\n## ' + text['question'], text['answer'], 'Sources: ' + ', '.join(f'[{s}](https://github.com/qoopia/qoopia-source/blob/main/{s})' for s in row['sources'])]
        description = data['summary'][lang]  # a search snippet; the full answers follow on the page
        if len(description) > 160: raise ValueError(f'summary.{lang} is longer than 160 characters')
        image_alt = 'Qoopia. Pick up where you left off.' if lang == 'en' else 'Qoopia. Продолжайте с того места, где остановились.'
        # The same reviewed answers as structured data; a JSON data block, so CSP script-src 'self' still holds.
        faq = json.dumps({'@context': 'https://schema.org', '@type': 'FAQPage', 'inLanguage': lang, 'url': f'https://qoopia.ai{route}',
                          'mainEntity': [{'@type': 'Question', 'name': row[lang]['question'], 'acceptedAnswer': {'@type': 'Answer', 'text': row[lang]['answer']}} for row in data['items']]},
                         ensure_ascii=False, separators=(',', ':')).replace('</', '<\\/')
        outputs[f'marketing-site{route}.html'] = f'''<!doctype html>
<html lang="{lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{title} — Qoopia</title><meta name="description" content="{esc(description)}"><link rel="canonical" href="https://qoopia.ai{route}"><link rel="alternate" hreflang="en" href="https://qoopia.ai/understand"><link rel="alternate" hreflang="ru" href="https://qoopia.ai/ru/understand"><link rel="alternate" hreflang="x-default" href="https://qoopia.ai/understand"><meta property="og:title" content="{title} — Qoopia"><meta property="og:description" content="{esc(description)}"><meta property="og:type" content="website"><meta property="og:site_name" content="Qoopia"><meta property="og:locale" content="{locale}"><meta property="og:locale:alternate" content="{other_locale}"><meta property="og:url" content="https://qoopia.ai{route}"><meta property="og:image" content="https://qoopia.ai/assets/social.png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:image:alt" content="{esc(image_alt)}"><meta name="twitter:card" content="summary_large_image"><link rel="icon" href="/brand/graphite/favicon.svg"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><link rel="stylesheet" href="{stamp('brand/base.css')}"><link rel="stylesheet" href="{stamp('style.css')}"><script type="application/ld+json">{faq}</script></head><body><a class="q-skip" href="#main-content">{'Skip to content' if lang == 'en' else 'К содержанию'}</a><div class="wrap"><header class="header"><a href="{home}" class="q-brand"><img alt="" src="/brand/graphite/qoopia-mark-ivory.svg" width="28" height="28"><img class="q-wordmark" alt="qoopia" src="/brand/graphite/qoopia-wordmark-ivory.svg" width="105" height="28"></a><nav aria-label="{'Navigation' if lang == 'en' else 'Навигация'}"><a href="/understand" lang="en">English</a><a href="/ru/understand" lang="ru">Русский</a><a href="{home}docs">{'Setup guide' if lang == 'en' else 'Установка'}</a></nav></header></div><main class="wrap doc" id="main-content" tabindex="-1"><p><a href="/understand" lang="en">English</a> · <a href="/ru/understand" lang="ru">Русский</a></p><h1>{title}</h1><p>{'Reviewed' if lang == 'en' else 'Проверено'}: {data['reviewed_date']} · Qoopia {version}</p>{''.join(sections)}<p><a href="{home}docs#agent-install">{'Read the installation task' if lang == 'en' else 'Прочитать задание для установки'}</a> · <a href="https://github.com/qoopia/qoopia-source">GitHub</a></p></main></body></html>
'''
        outputs[f'docs/discovery/UNDERSTAND-{lang.upper()}.md'] = '\n\n'.join(markdown) + '\n'
    for path, content in outputs.items():
        target = root / path
        if check:
            if not target.exists() or target.read_text() != content:
                raise ValueError(f'Generated content differs: {path}')
        else:
            target.write_text(content)
    print(json.dumps({'generated_files':list(outputs),'check':check}))

if __name__ == '__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--check',action='store_true')
    render(check=parser.parse_args().check)
