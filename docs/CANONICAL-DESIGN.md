# Qoopia V1 canonical surfaces

Approved source: `Qoopia brandbook canonical.zip`, SHA256 `2f5bc2591ce8f3006f229d073c16d2f2fa51f3e5dd143f26896d741737364a00`, approved 2026-09-11. Exact extracted originals remain in the project design/qoopia-handoff directory. Previous orange Continuity and olive designs are superseded.

The runtime serves a narrow allowlist under /brand. Dashboard, owner login, OAuth consent and the independent authorization service share local fonts, tokens and exact SVG marks. The dashboard version includes CSS and token bytes, so a design change raises the existing reload notification. No API, role, workspace, OAuth, memory or Bridges policy changes are introduced.

Typography: Marck Script for the wordmark and short accents; IBM Plex Sans for interface text. Both bundled files contain Latin and Cyrillic. Upstream font files: Google Fonts repository, ofl/marckscript/MarckScript-Regular.ttf and ofl/ibmplexsans/IBMPlexSans[wdth,wght].ttf, retrieved 2026-09-11. SIL Open Font License texts ship alongside the fonts and in bundle notices. The release source inventory pins their exact bytes.

Accessibility decisions within the approved palette: small secondary labels use smoke rather than muted; errors use a white border and explicit text; disconnected dots are hollow. Body copy is 17px; compact metadata 14px. Keyboard focus remains visible. Reduced motion disables the continuation reveal. Dense navigation retains its existing behavior. The small optical SVG is used for the 28px dashboard mark; web wordmark uses the primary from 32px.

Mail uses the exact SVG and actual Marck Script rendered into a CID PNG attachment, avoiding remote tracking and unsupported webfonts. The visible text remains HTML, with IBM Plex Sans falling back to Arial/sans-serif. Confirmation URL, one-use token, ten-minute lifetime and plain-text alternative are unchanged. Literal canonical colors in inline mail CSS are intentional for email-client compatibility. No real email is sent by the test fixture.

The native icon is scaled from the approved 1024px PNG before signing. Platform packaging applies native sizing and clear space; signed DMGs are never modified. The complete approved SVG/PNG masters and RU/EN brandbooks accompany the project handoff.

Marketing source lives in marketing-site/. Its release.json is a build template: the final artifact fills source commit, package filenames, sizes and checksums from the signed outputs. Public URLs remain null until distribution is authorized. This avoids committing a self-referential hash or exposing private release URLs. Existing installation, connectivity and privacy boundaries are preserved.

## Mark and wordmark alignment

Whenever Q and Qoopia appear together, use the shared horizontal `.q-brand` lockup, with their visible lower edges aligned. Subtitles (including V1 · Your memory) go outside this row. Do not center the mark against a multi-line name/subtitle block. Keep mark sizing proportional to the lockup font size; `.q-wordmark` compensates for Marck Script’s font metrics. This applies to dashboard, login/OAuth, marketing, and rendered email branding.
