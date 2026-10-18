#!/usr/bin/env python3
"""Browser regressions on dashboard-preview.ts synthetic data only. Never uses a real profile."""
import json
import os
from pathlib import Path
import sys
from playwright.sync_api import sync_playwright

root = Path(sys.argv[1]).resolve()
config = json.loads((root / 'preview.json').read_text())
assert config['fixture'] == 'qoopia-dashboard-preview/1'
assert config['url'].startswith('http://127.0.0.1:')
origin = config['url']
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path=os.environ.get("QOOPIA_BROWSER_EXECUTABLE"))
    context = browser.new_context(viewport={'width': 1440, 'height': 1000}, service_workers='block')
    response = context.request.post(origin + '/api/dashboard/login', headers={'Origin': origin, 'Authorization': 'Bearer ' + config['owner_key']})
    assert response.status == 200
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(origin + '/dashboard#overview')
    page.wait_for_load_state('networkidle')
    page.locator('.ov-tile').first.wait_for()
    page.screenshot(path=str(root / 'overview-draft-en.png'))
    if page.locator('#canonProposals [data-accept="true"]').count():
        page.locator('#canonProposals [data-accept="true"]').click()
    page.locator('#canonProposals').wait_for(state='hidden')
    page.goto(origin + '/dashboard#canon')
    page.locator('.canon-list').wait_for()
    assert page.locator('#canonForm, #canonText, #canonMode').count() == 0
    assert page.locator('[data-retire]').count() == 2
    denied = context.request.post(origin + '/api/dashboard/canons', data={'text': 'No manual creation'}, headers={'Origin': origin, 'X-Qoopia-CSRF': '1'})
    assert denied.status == 405
    page.screenshot(path=str(root / 'canon-en.png'))
    page.locator('.topbar [data-language="ru"]').click()
    assert 'Агент создаёт каноны' in page.locator('#main').inner_text()
    page.set_viewport_size({'width': 390, 'height': 844})
    page.screenshot(path=str(root / 'canon-ru-phone.png'))
    assert page.evaluate('() => document.documentElement.scrollWidth <= innerWidth')
    page.set_viewport_size({'width': 1440, 'height': 1000})
    page.locator('.topbar [data-language="en"]').click()
    page.goto(origin + '/dashboard#agents/' + config['agents']['working'] + '/sessions/codex%3Ascroll-preview')
    page.locator('#sessMore').wait_for()
    assert page.locator('[data-mid]').count() == 500
    anchor = page.locator('[data-mid]').first
    marker = anchor.get_attribute('data-mid')
    before = anchor.bounding_box()['y']
    page.locator('#sessMore').click()
    page.locator('[data-mid]').nth(999).wait_for()
    after = page.locator('[data-mid="' + marker + '"]').bounding_box()['y']
    assert abs(after - before) <= 2, (before, after)
    page.goto(origin + '/dashboard#overview')
    page.locator('.ov-tile').first.wait_for()
    page.locator('.topbar [data-language="ru"]').click()
    page.screenshot(path=str(root / 'graphite-overview-ru.png'))
    page.locator('.topbar [data-language="en"]').click()
    page.set_viewport_size({'width': 390, 'height': 844})
    page.screenshot(path=str(root / 'graphite-mobile-en.png'))
    page.set_viewport_size({'width': 1440, 'height': 1000})
    assert page.evaluate("() => document.fonts.check('12px Manrope')")
    assert context.request.get(origin + '/brand/Manrope.woff2').status == 200
    # Known access expiry and authentication failures use distinct recovery text.
    state = context.request.get(origin + '/api/dashboard/memory').json()
    state['model'].update({'state': 'ready', 'runtime': 'codex', 'sign_in': {'state': 'expiring', 'access_expires_at': '2026-10-18T00:00:00Z', 'refresh_available': True}})
    page.route('**/api/dashboard/memory', lambda r: r.fulfill(json=state))
    page.goto(origin + '/dashboard#memory')
    page.get_by_text('Memory model access expires soon:', exact=False).wait_for()
    state['model']['state'] = 'auth_required'
    page.reload()
    page.get_by_text('The memory model is signed out.', exact=False).wait_for()
    page.screenshot(path=str(root / 'memory-sign-in-en.png'))
    assert not errors, errors
    context.close()
    browser.close()
print(json.dumps({'status': 'PASS', 'checks': ['draft approval', 'canon view and retire controls', 'manual API rejected', 'RU mobile', 'transcript scroll anchor', 'expiry warning', 'sign-in recovery', 'no browser errors']}))
