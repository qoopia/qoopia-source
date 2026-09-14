"""Real disposable HTTP app + fresh headless Chromium, using an installed cache.
Run from p2-build with --output NEW_DIRECTORY --browser-cache INSTALLED_CACHE.
No browser download, persistent profile, native model invocation or login bypass.
"""
import argparse
import json
import os
import pathlib
import re
import subprocess
import tempfile
import time
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True)
    parser.add_argument('--browser-cache', default=os.environ.get('PLAYWRIGHT_BROWSERS_PATH'),
                        help='Existing Playwright cache; required unless PLAYWRIGHT_BROWSERS_PATH is set')
    args = parser.parse_args()
    if not args.browser_cache or args.browser_cache == '0':
        parser.error('Provide an explicit installed --browser-cache directory (no download)')
    cache = pathlib.Path(args.browser_cache).expanduser().resolve(strict=True)
    if not cache.is_dir():
        parser.error('--browser-cache must be an existing directory')
    out = pathlib.Path(args.output).resolve()
    out.mkdir(parents=True, exist_ok=True)
    if any(out.iterdir()):
        parser.error('Use a new or empty output directory; prior evidence is never overwritten')
    transcript, requests, errors = [], [], []
    phase, passed = 'server startup', False
    started = time.monotonic()

    def checkpoint(message):
        transcript.append(message)
        (out / 'transcript.json').write_text(json.dumps(transcript, indent=2) + '\n')

    # Path/method/status only: never record auth headers, cookies, bodies or query strings.
    def request_event(request, event, status=None):
        if len(requests) < 250:
            requests.append({'elapsed_ms': round((time.monotonic() - started) * 1000),
                             'phase': phase, 'event': event, 'method': request.method,
                             'path': urlsplit(request.url).path, 'status': status})

    with tempfile.TemporaryDirectory(prefix='p2-ui-') as tmp:
        seed = pathlib.Path(tmp) / 'seed.json'
        env = {'PATH': os.environ['PATH'], 'HOME': tmp, 'TMPDIR': tmp,
               'XDG_CONFIG_HOME': tmp + '/config', 'XDG_CACHE_HOME': tmp + '/cache',
               'XDG_DATA_HOME': tmp + '/data', 'NODE_ENV': 'test',
               'QOOPIA_PORT': '0', 'QOOPIA_HOST': '127.0.0.1',
               'PLAYWRIGHT_BROWSERS_PATH': str(cache)}
        with (out / 'server.log').open('w') as log:
            child = subprocess.Popen(['bun', 'tests/helpers/p2-ui-server.ts', str(seed)],
                                     env=env, stdout=log, stderr=log)
            original_env = dict(os.environ)
            try:
                for _ in range(100):
                    if seed.exists() or child.poll() is not None:
                        break
                    time.sleep(.1)  # Bounded server-ready file polling, not UI readiness.
                if not seed.exists():
                    raise RuntimeError('NOT RUN: disposable HTTP server unavailable; inspect server.log')
                info = json.loads(seed.read_text())
                # Driver and browser both get disposable HOME; the explicit cache selects
                # the revision required by installed Playwright, without copying a profile.
                os.environ.clear()
                os.environ.update(env)
                phase = 'browser launch'
                with sync_playwright() as pw:
                    browser = pw.chromium.launch(headless=True, env=env)
                    try:
                        context = browser.new_context(viewport={'width': 1280, 'height': 900})
                        page = context.new_page()
                        page.on('pageerror', lambda error: errors.append(str(error)))
                        page.on('request', lambda request: request_event(request, 'started'))
                        page.on('response', lambda response: request_event(response.request, 'response', response.status))
                        page.on('requestfinished', lambda request: request_event(request, 'finished'))
                        page.on('requestfailed', lambda request: request_event(request, 'failed'))
                        phase = 'login contract'
                        # Per-request Bearer -> scoped cookie, never context-wide Authorization.
                        login = context.request.post(info['url'] + '/api/dashboard/login', headers={
                            'Authorization': 'Bearer ' + info['api_key'], 'Origin': info['url']})
                        (out / 'login-contract.json').write_text(json.dumps({
                            'status': login.status,
                            'request_contract': 'per-request Authorization Bearer; same Origin; no key in body'}, indent=2))
                        assert login.status == 200, f'Dashboard login returned HTTP {login.status}'
                        assert login.json()['ok'] is True
                        assert login.json()['type'] == 'owner' and login.json()['isAdmin'] is True
                        assert login.headers.get('cache-control') == 'no-store'
                        assert info['api_key'] not in login.text()
                        cookies = [cookie for cookie in context.cookies() if cookie['name'] == 'qoopia_dash']
                        assert len(cookies) == 1 and cookies[0]['httpOnly'] and cookies[0]['sameSite'] == 'Strict' and cookies[0]['path'] == '/api/dashboard'
                        authenticated = context.request.get(info['url'] + '/api/dashboard/authority/skills')
                        assert authenticated.status == 200, f'Cookie-only Skills request returned HTTP {authenticated.status}'
                        checkpoint('Real owner Bearer login -> HttpOnly scoped cookie -> cookie-only Skills read')

                        phase = 'dashboard readiness'
                        page.goto(info['url'] + '/dashboard#overview', wait_until='domcontentloaded')
                        expect(page.locator('#appView')).to_be_visible()
                        # boot -> overview Promise.all -> paint. Network idle is unrelated
                        # to actionability on a dashboard that polls every five seconds.
                        expect(page.locator('#feedSub')).to_have_text(re.compile(r'^\d+ recent events$'))
                        expect(page.locator('#ccAgents .loading')).to_have_count(0)
                        skills = page.get_by_role('link', name='Skills', exact=True)
                        expect(skills).to_be_enabled()
                        skills.click()
                        status = page.locator('#skillStatus')
                        expect(status).to_contain_text('Library is current.')
                        expect(page.locator('#skillCards')).to_contain_text('Your library is empty.')
                        checkpoint('Overview rendered -> actionable Skills navigation -> empty library loaded')

                        phase = 'keyboard capture'
                        create = page.get_by_role('button', name='Create a skill', exact=True)
                        expect(create).to_be_visible()
                        create.focus()
                        page.keyboard.press('Enter')
                        expect(page.get_by_label('Title', exact=True)).to_be_focused()
                        page.get_by_role('button', name='Use synthetic CSV sample', exact=True).click()
                        expect(status).to_contain_text('Synthetic sample selected. No runtime task has been executed.')
                        page.get_by_role('button', name='Save draft', exact=True).click()
                        expect(status).to_contain_text('Draft saved.')
                        checkpoint('Keyboard capture and synthetic sample saved through real CSRF-protected handler')

                        phase = 'compile and review'
                        page.get_by_role('button', name='Compile preview', exact=True).click()
                        expect(page.get_by_role('heading', name='Before / after diff', exact=True)).to_be_visible()
                        instructions = page.get_by_label('Final native instructions', exact=True)
                        expect(instructions).to_contain_text('input.csv')
                        native_bytes = instructions.text_content()
                        page.get_by_role('button', name='Русский', exact=True).filter(visible=True).click()
                        translated_instructions = page.get_by_label('Итоговые инструкции для клиента', exact=True)
                        expect(translated_instructions).to_have_text(native_bytes)
                        page.get_by_role('button', name='English', exact=True).filter(visible=True).click()
                        expect(instructions).to_have_text(native_bytes)
                        instructions.focus()
                        expect(instructions).to_be_focused()
                        expect(page.get_by_label('Target scope', exact=True)).to_have_value('project')
                        page.screenshot(path=str(out / 'review.png'), full_page=True)
                        page.get_by_role('button', name='Approve for local use', exact=True).click()
                        assign = page.get_by_role('button', name='Assign exact version', exact=True)
                        expect(assign).to_be_enabled()
                        expect(page.get_by_label('Enrolled runtime', exact=True)).not_to_have_value('')
                        expect(page.get_by_label('Approved scope', exact=True)).not_to_have_value('')
                        phase = 'assignment'
                        assign.click()
                        expect(status).to_contain_text('next managed native session')
                        expect(status).to_have_attribute('role', 'status')
                        expect(status).to_have_attribute('aria-live', 'polite')
                        expect(page.locator('#skAssignments')).to_contain_text('Desired: active')
                        expect(page.locator('#skOutcomes')).to_contain_text('No runtime task has been reported.')
                        checkpoint('Diff -> final bytes keyboard focus -> local review -> exact assignment; no runtime task invented')

                        phase = 'viewport and zoom'
                        for width, zoom in [(360, 1), (1280, 2)]:
                            page.set_viewport_size({'width': width, 'height': 900})
                            page.evaluate('(zoom) => document.documentElement.style.zoom = zoom', zoom)
                            assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1'), f'Horizontal overflow at {width}px / {zoom}x'
                            expect(page.get_by_role('button', name='Library', exact=True)).to_be_visible()
                            expect(page.get_by_role('button', name='Pause', exact=True)).to_be_visible()
                            page.screenshot(path=str(out / f'width-{width}-zoom-{zoom}.png'), full_page=True)
                        checkpoint('360px and 200% zoom: no horizontal page overflow; library/assignment controls visible')

                        phase = 'offline library'
                        page.evaluate('document.documentElement.style.zoom = 1')
                        context.set_offline(True)
                        page.get_by_role('button', name='Library', exact=True).click()
                        reload = page.get_by_role('button', name='Reload library', exact=True)
                        expect(reload).to_be_visible()
                        expect(status).to_have_attribute('role', 'alert')
                        expect(status).to_contain_text('OFFLINE:')
                        checkpoint('Offline read settled: actionable reload and explicit OFFLINE alert')
                        context.set_offline(False)
                        phase = 'online reload'
                        reload.click()
                        expect(status).to_contain_text('Library is current.')
                        expect(status).to_have_attribute('role', 'status')
                        expect(create).to_be_visible()
                        expect(page.locator('#skillCards [data-skill]')).to_have_count(1)
                        expect(page.locator('#skillAttention')).to_contain_text('Ready for the next session.')
                        assert not errors, errors
                        checkpoint('Online reload restored saved skill and assignment; no page errors; manual screen reader NOT RUN')
                        passed = True
                    finally:
                        browser.close()
            finally:
                os.environ.clear()
                os.environ.update(original_env)
                (out / 'ui-result.json').write_text(json.dumps({
                    'status': 'PASS' if passed else ('NOT RUN' if phase in ('server startup', 'browser launch') else 'FAIL'),
                    'phase': phase, 'manual_screen_reader': 'NOT RUN',
                    'page_errors': errors, 'requests': requests}, indent=2) + '\n')
                child.terminate()
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()


if __name__ == '__main__':
    main()
