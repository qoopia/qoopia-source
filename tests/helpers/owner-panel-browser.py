"""Browser acceptance for the owner view using synthetic API responses."""
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
import mimetypes

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
ORIGIN = "http://127.0.0.1:48637"


def run(owner: bool, mobile: bool):
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 390 if mobile else 1280, "height": 844 if mobile else 900})
        page = context.new_page()
        requests = []

        def fulfill(route):
            parsed = urlsplit(route.request.url)
            path = parsed.path
            if path == "/dashboard":
                body = (ROOT / "src/public/dashboard.html").read_bytes()
                route.fulfill(status=200, body=body, content_type="text/html")
            elif path.startswith("/brand/"):
                file = (ROOT / "src/public/brand" / path.removeprefix("/brand/")).resolve()
                if not file.is_relative_to(ROOT / "src/public/brand") or not file.is_file():
                    route.fulfill(status=404, body="missing")
                else:
                    route.fulfill(status=200, body=file.read_bytes(), content_type=mimetypes.guess_type(file)[0] or "application/octet-stream")
            elif path == "/api/dashboard/identity":
                route.fulfill(status=200, json={"linked": True})
            elif path == "/api/dashboard/agents":
                route.fulfill(status=200, json={"agents": []})
            elif path == "/api/dashboard/profile":
                route.fulfill(status=200, json={"email": "owner@example.test", "service_owner": owner})
            elif path == "/api/dashboard/memory":
                route.fulfill(status=403, json={"error": "fixture"})
            elif path == "/api/dashboard/service-owner":
                requests.append(route.request.url)
                if not owner:
                    route.fulfill(status=403, json={"error": "Service owner access required"})
                    return
                n = int(parse_qs(parsed.query).get("page", ["0"])[0])
                html = f'<section class="q-owner"><nav class="profile-nav"><a href="#accounts" data-owner-section="accounts">Accounts</a></nav><section id="accounts"><h2>Private accounts, page {n + 1}</h2>'
                if n == 0:
                    html += '<a href="?page=1" data-owner-page="1">Next</a>'
                html += '</section></section>'
                route.fulfill(status=200, json={"html": html}, headers={"cache-control": "no-store"})
            else:
                route.fulfill(status=404, json={"error": "fixture"})

        page.route(ORIGIN + "/**", fulfill)
        page.goto(ORIGIN + "/dashboard#profile")
        page.wait_for_load_state("networkidle")
        page.get_by_role("heading", name="Profile").wait_for()
        if owner:
            page.locator("#profileOwnerPanel").click()
            page.get_by_role("heading", name="Private accounts, page 1").wait_for()
            assert page.url == ORIGIN + "/dashboard#owner", page.url
            page.get_by_role("link", name="Next").click()
            page.get_by_role("heading", name="Private accounts, page 2").wait_for()
            assert any("page=1" in req for req in requests), requests
            assert page.locator("#loginView").is_hidden()
        else:
            assert page.locator("#profileOwnerPanel").count() == 0
            assert not requests
        if mobile:
            assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
        context.close()
        browser.close()


if __name__ == "__main__":
    run(True, False)
    run(True, True)
    run(False, False)
    print("owner panel browser acceptance passed")
