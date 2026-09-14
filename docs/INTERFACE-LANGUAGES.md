# Interface languages

Qoopia supports English and Russian on the marketing site and dashboard. Use the EN / RU control, or an explicit `?lang=en` / `?lang=ru` link. Priority is URL choice, the shared qoopia.ai preference cookie, local storage, then browser language (Russian variants select ru; all others select en). A choice survives reloads. Cookies are shared only on qoopia.ai and its subdomains; independent/local installations keep their own preferences.

The selector changes message text and accessibility attributes in place. It does not rerender screens, reload, reset drafts, touch selected files, or make API writes. Notes, names, source text, code, connection addresses, identifiers and commands are not translated. Agent instructions and sample task data stay separate from interface localization. Dates/numbers use Intl; membership counts use Russian plural forms.

## Editing copy

English source messages are the keys in `src/public/brand/i18n.ru.json`. Use `QI.msg(source, params)` for UI text inside the dashboard; `data-i18n` / `data-i18n-aria-label` etc. for static HTML. Plain user content must never be passed as a message key. The locale runtime binds only explicitly generated tokens with a random per-document prefix and explicitly marked static nodes; it never searches user content for English words. Tokens are inserted as text, never evaluated as HTML. Do not use QI.msg in API payloads, input values, CSS selectors or machine identifiers. Use QI.plain only when actual plain UI text is required (e.g. a native dialog), and keep persisted content untranslated.

Edit `scripts/ui/i18n-runtime.js` for locale behaviour. Run `bun scripts/build-ui-locales.ts` to update the generated synchronous runtime and copy it to marketing-site/brand. The public asset allowlist serves only the built runtime. No translation service, remote font, or new dependency is used.

Dashboard illustrations exist in both languages and use content-hashed filenames. Update their URL map in marketing-site/site.js after rendering the disposable UI fixture. Preserve the Q mark / wordmark alphabetic baseline; p descends below it.

Validation: `bun test tests/i18n.test.ts tests/brand-assets.test.ts`; `bun scripts/build-ui-locales.ts --check`; `python3 tests/helpers/i18n-browser.py` against the disposable bridges-ui-server fixture and the marketing preview on port 18768. The browser suite covers both languages at 360/768/1440, forms, file selection, user content, zero writes on switching, saved preference, browser fallback and blocked storage.

## Sign-in messages

Profile, dashboard and external-connection setup pass the selected EN/RU language to the sign-in broker. A pending request retains that language across service restarts, including Google account selection. The confirmation email, plain-text alternative and confirmation page use it; callers without a preference default to English. The email contains a local CID brand image and a complete fallback URL, with no remote image tracking. Merely opening a link still cannot consume the one-use proof. Missing, expired and offline confirmation states provide a recovery path.

The account-service database adds `login_requests.language` with an `en` default; no memory schema migration is involved. Existing pending requests remain valid. Preserve the account database and take a verified backup before replacing the service.
