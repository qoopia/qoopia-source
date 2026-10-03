---
name: Qoopia — Graphite Focus 2.0.1
description: Warm dark neutrals and exact vector identity across the compact workspace, website and account surfaces.
colors:
  graphite: "#111110"
  ivory: "#f2efe9"
  surface: "#191918"
  divider: "#343330"
  smoke: "#c3bdb4"
  control: "#8a847b"
  assistant: "#242321"
  website-action-hover: "#d8d2c8"
typography:
  headline:
    fontFamily: "Manrope, sans-serif"
    fontSize: "26px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.02em"
  title:
    fontFamily: "Manrope, sans-serif"
    fontSize: "18px"
    fontWeight: 600
    lineHeight: 1.4
  body:
    fontFamily: "Manrope, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.6
  navigation:
    fontFamily: "Manrope, sans-serif"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: 1.4
  label:
    fontFamily: "Manrope, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.6
  metadata:
    fontFamily: "Manrope, sans-serif"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.6
  website-display:
    fontFamily: "Manrope, system-ui, sans-serif"
    fontSize: "clamp(44px, 5.2vw, 76px)"
    fontWeight: 550
    lineHeight: 1.12
    letterSpacing: "-0.035em"
  website-headline:
    fontFamily: "Manrope, system-ui, sans-serif"
    fontSize: "clamp(32px, 3.5vw, 48px)"
    fontWeight: 550
    lineHeight: 1.12
    letterSpacing: "-0.035em"
  website-body:
    fontFamily: "Manrope, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.65
  website-action:
    fontFamily: "Manrope, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 650
    lineHeight: 1.65
  account-headline:
    fontFamily: "Manrope, system-ui, sans-serif"
    fontSize: "32px"
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: "-0.025em"
  account-body:
    fontFamily: "Manrope, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.5
  account-action:
    fontFamily: "Manrope, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 500
    lineHeight: 1.5
rounded:
  detail: "4px"
  navigation: "6px"
  field: "7px"
  panel: "12px"
  floating: "16px"
  product-example: "14px"
spacing:
  tight: "4px"
  compact: "8px"
  control: "12px"
  panel: "16px"
  section: "24px"
  columns: "36px"
  website-gutter: "40px"
  website-mobile-gutter: "20px"
components:
  button-primary:
    backgroundColor: "{colors.ivory}"
    textColor: "{colors.graphite}"
    rounded: "{rounded.navigation}"
    padding: "6px 12px"
  button-primary-hover:
    backgroundColor: "{colors.smoke}"
    textColor: "{colors.graphite}"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.ivory}"
    rounded: "{rounded.navigation}"
    padding: "6px 12px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ivory}"
    rounded: "{rounded.field}"
    padding: "8px 10px"
  navigation-active:
    backgroundColor: "{colors.divider}"
    textColor: "{colors.ivory}"
    typography: "{typography.navigation}"
    rounded: "{rounded.navigation}"
    padding: "7px 10px"
  note-filter:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.smoke}"
    rounded: "{rounded.floating}"
    padding: "5px 11px"
  panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ivory}"
    rounded: "{rounded.panel}"
    padding: "16px"
  chat-user:
    backgroundColor: "{colors.divider}"
    textColor: "{colors.ivory}"
    rounded: "{rounded.panel}"
    padding: "10px 12px"
  chat-assistant:
    backgroundColor: "{colors.assistant}"
    textColor: "{colors.ivory}"
    rounded: "{rounded.panel}"
    padding: "10px 12px"
  website-button-primary:
    backgroundColor: "{colors.ivory}"
    textColor: "{colors.graphite}"
    typography: "{typography.website-action}"
    rounded: "{rounded.field}"
    padding: "10px 18px"
  website-button-primary-hover:
    backgroundColor: "{colors.website-action-hover}"
    textColor: "{colors.graphite}"
  website-button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.ivory}"
    typography: "{typography.website-action}"
    rounded: "{rounded.field}"
    padding: "10px 18px"
  account-button-primary:
    backgroundColor: "{colors.ivory}"
    textColor: "{colors.graphite}"
    typography: "{typography.account-action}"
    rounded: "{rounded.navigation}"
    padding: "8px 18px"
---

# Design System: Qoopia

## Overview

**Creative North Star: "Graphite Focus"**

Graphite Focus joins warm dark neutrals, bundled Manrope, exact vector identity, flat records and fine separators. The accepted website and account extension uses this same visual system with larger type and more open spacing for reading and decisions. The approved dashboard desktop density remains approximately 75% of the former dashboard, implemented through actual type and spacing values rather than CSS zoom. Its compact type and controls remain dashboard-specific; mobile and coarse-pointer controls retain larger targets.

The accepted web scope covers the dashboard in `src/public/dashboard.html` and `src/public/brand/dashboard.css`, `agent-chat.css`, `dashboard.js` and `agent-chat.js`; all pages in `marketing-site/`; shared account and consent styling in `src/public/brand/base.css` and `tokens.css`; and the dashboard PWA shell and offline page. Shared base styles and tokens now carry Graphite Focus and Manrope. Identity comes from the approved Graphite Focus 2.0.1 assets under `src/public/brand/graphite/`, copied unchanged from the owner's private Graphite design package (outside this repository). Product scope lives in `PRODUCT.md`; route composition and purpose remain in `.impeccable/briefs/dashboard.md` and `website.md`.

Native iOS uses SwiftUI around the existing mobile WebKit dashboard and preserves the exact canonical logo. Build 5.0.8 (3) fixes the account-to-workspace navigation loop reported in build 2. Email confirmation opens the linked dashboard without permanent browser controls; native settings remain in its menu. Engineering acceptance covers the actual Simulator app: one email, confirmation in a separate WebKit browser, background/foreground return, dashboard rendering and process termination/relaunch with the session preserved. The isolated full flow uses synthetic data and a loopback transport fixture; production URL policy and live HTTPS entry are verified separately. The signed release contains no fixture overrides. Public App Store submission still follows owner beta acceptance; no physical iPhone run is claimed here. See `docs/operations/ios-direct-dashboard-508-build3-20260921.md` and `.impeccable/briefs/ios.md`.

**Key Characteristics:**

- Compact desktop dashboard controls with explicit text labels.
- Larger website display type and account controls within the same identity.
- Flat rows and restrained tonal separation.
- Exact vector identity and bundled Latin/Cyrillic typography.
- Persistent owner chat that leaves navigation available.
- Mobile reflow with larger controls and wrapping content.

## Colors

Warm graphite and ivory carry the accepted web surfaces; the palette has no chromatic accent. Native picker and recovery chrome use semantic platform colors, verified in light and dark Simulator captures.

### Primary

- **Ivory:** primary text, focus, primary actions and selected-state emphasis.

### Neutral

- **Graphite:** the canvas, sidebar and top bar.
- **Surface:** grouped forms, panels, secondary hover and the floating chat.
- **Divider:** quiet separators, selected navigation and user messages.
- **Smoke:** secondary text, timestamps and primary-action hover.
- **Control:** visible field and control boundaries; stronger than a divider.
- **Assistant:** agent-message fill and the chat composer.
- **Website action hover:** a muted warm fill for website primary-button hover.

**The Explicit State Rule.** Describe connection, loading, error and permission states with visible words; neutral color alone cannot distinguish them.

## Typography

**Web display and body font:** bundled Manrope, with sans-serif fallback. The lowercase wordmark is a supplied SVG, never typeset text. Technical identifiers, code and transcript content may use the existing `ui-monospace, monospace` stack.

The unprefixed frontmatter type roles record the reused compact dashboard desktop hierarchy: headline, section title, body/navigation, labels and metadata. Page headings reduce to 24px at the compact shell breakpoint. Chat titles use 14px semibold; message text inherits the body size with 1.65 line height. Working prose is capped at 75 characters where the workflow layout permits. Counts use tabular numerals. Mobile form text is 16px. Mobile statistic captions use 11px type and wrap within their row.

The `website-*` roles describe the larger marketing hierarchy. Website reading paragraphs use 16px text, reducing to 15px below 700px, with a 68-character prose cap where the layout permits. The homepage display reduces to 42px with 1.14 line height below 700px. The `account-*` roles describe account and consent surfaces; account fields use 16px text. The offline reconnect page also loads bundled Manrope. These roles do not replace the compact dashboard hierarchy. Native chrome uses Dynamic Type and system typography; embedded web content retains Manrope.

**The Quiet Heading Rule.** Use sentence-case headings and ordinary labels. Decorative eyebrows are hidden in dashboard and account surfaces and are not a reusable type role.

## Layout

The dashboard desktop uses a sticky sidebar (196px), a flexible main column, a thin top bar and a content container capped at 1600px. Main content padding is 24px 28px with 80px below for floating controls. Repeated records use full-width rows; Overview combines a four-column metric strip with two equal content columns and a 36px gap.

At 1100px, metric spacing and column gaps tighten. At 900px, the sidebar becomes a sticky top shell with a collapsible single-column menu, the clock hides, content columns stack and content padding becomes 20px 18px. Workflow grids collapse at 760px; connection grids at 700px. At 600px, metrics use two columns and each agent's name, memory status and wrapping statistics occupy separate rows. Long names and content wrap instead of extending the canvas.

Desktop navigation has a 34px minimum height; common action buttons have a 32px minimum. At 600px or with a coarse pointer, shared buttons and fields use 44px minimum targets and form text uses 16px. Language buttons explicitly become 44px square. Narrow navigation rows are also at least 44px high. Do not shrink mobile targets to achieve desktop density.

The website uses a centered container capped at 1200px with the website gutter; reading surfaces cap at 860px. Two-column sections tighten at 1050px and stack at 700px, with the website mobile gutter. Website buttons and selects retain a 44px minimum height; at 600px or with a coarse pointer, language and navigation controls also use larger targets and fields use 16px text. Header navigation simplifies on narrow screens while preserving account, download and language access.

Account forms use a centered column capped at 560px. The profile expands to 1040px with two columns and stacks at 700px; all account buttons have a 44px minimum height and profile fields a 48px minimum. The PWA opens the same responsive dashboard; its offline state is a small single-column reconnect page, not an offline workspace.

## Elevation & Depth

Depth comes from fill, borders and stacking. Working panels and the floating chat have no shadow. The chat sits above page content with a stronger control border; bridge dialogs use a dark backdrop. Avoid importing campaign texture or glow behind working text.

**The Flat Record Rule.** Give repeated agents, activity and connection records separators; reserve containers for grouped controls, dialogs and conversations.

Dashboard motion is limited to existing state feedback: 150ms agent-border transitions and 180ms scroll-control visibility/movement. Reduced-motion preferences disable transitions, animations and smooth scrolling. Chat opening and route access are immediate. The website product stage settles once on entry over 850ms; buttons and text links use 180ms feedback. Reduced motion leaves the stage visible and removes transitions.

## Shapes

Controls are gently rounded: navigation and shared buttons use the navigation radius, workflow fields and actions the field radius. Panels and message bubbles use the panel radius; the floating chat uses the floating radius. Message bubbles tighten one lower corner to the detail radius on the speaker's side. Separators and control outlines are one pixel. Website product examples use the product-example radius; website buttons use the field radius, account buttons the navigation radius.

Use the exact supplied filled Q and vector wordmark. The shell uses the small mark at 28px high and the wordmark at 96px wide; login uses a 144px-wide wordmark. Preserve the master outline, proportions and clear space. Website and account headers use a 28px mark and a 105px-wide wordmark; the narrow website header reduces these to 22px and 85px. The PWA manifest uses the Graphite app icons. Interface icons are inline stroked SVGs, normally 16px in dashboard navigation and 20px in chat controls. Native chrome follows SF Symbols while retaining the canonical brand assets.

## Components

### Buttons

Primary actions use ivory fill with graphite text; secondary actions are transparent or surface-filled with a visible control outline. Shared buttons use 13px medium text and the frontmatter padding; workflow buttons use 7px 12px padding and the field radius. Hover increases surface contrast or darkens the ivory fill to smoke. Keyboard focus is an ivory outline: 3px with a 3px offset generally, 2px with a 4px offset within workflows. Disabled actions retain a label and show a disabled state.

Website buttons use the `website-button-*` roles, a 44px minimum height and 180ms background feedback; their focus ring is 2px with a 5px offset. Website secondary actions use a control-colored outline. Account actions use the `account-button-primary` role, a 44px minimum height and a 3px focus outline with a 4px offset. These larger controls do not change dashboard desktop button density.

### Chips

Metadata chips use quiet neutral fills and compact text. Note filters are outlined, rounded controls; selection adds an ivory border and text. Overview metadata remains plain text, without chip backgrounds. A filter is an action and must retain its keyboard and touch target behavior.

### Cards / Containers

Panels use the frontmatter surface, padding and radius with a divider border. Nested panels reduce to a separator instead of accumulating boxes. Agent rows remain flat; status text sits beside the identity on desktop and beneath it on mobile.

### Inputs / Fields

Visible labels precede surface-filled fields with a control-colored outline. Placeholders use smoke and are supplementary to labels. Maintain visible focus and preserve input when an action fails. Long message and technical content wraps. The chat composer is sticky within the panel and uses the assistant surface; its textarea spans 76–180px in height.

### Navigation

The owner's flat menu contains Overview, Memory, Agents, Connections, Agent conversations, Skills, Bridges, External folder, Files and Search. Overview is the entry view; explicit supported route hashes still work. Active links use a divider fill, ivory text, semibold weight and `aria-current="page"`. More, Knowledge, Activity and My Qoopia agent are not navigation tabs. Memory and Connections are filtered by the server-provided owner workspace context; presentation never grants authority.

### Website and account navigation

Website navigation is a compact horizontal row that wraps and simplifies on narrow screens. Links, download selection and language buttons remain native controls with visible focus. Account and consent pages share the exact vector brand lockup and the Graphite base; field labels, access states and recovery instructions remain explicit. Website product captures and illustrative records are labelled as demonstration data.

### Persistent owner chat

The global chat is a nonmodal region outside the routed main content. Its launcher remains available across navigation. Desktop starts at up to 480px wide and 710px high, expanding to up to 820px wide; at 600px it fills the viewport with an 8px inset. It has a heading, expand/minimize controls, a scrolling body and a sticky composer. User bubbles align right; agent bubbles align left, with visible author labels and a 90% width cap.

Setup, subscription sign-in, server-provided model choices, conversation history, pending approvals and Telegram connection controls stay within this panel. Existing steward and permission states determine which actions appear. Enter sends, Shift+Enter adds a line, and Escape inside the panel minimizes it and restores prior focus. Closing or changing routes keeps the draft; logout disposes the panel and clears its local content. This source-level behavior does not demonstrate a successful external model sign-in or a production rollout.

## Do's and Don'ts

### Do:

- **Do** use the approved 2.0.1 SVG assets unchanged and bundled Manrope for English and Russian web text, including the offline state.
- **Do** keep the approved compact dashboard desktop density, the separate website/account scale, and larger mobile controls.
- **Do** use explicit labels, visible focus and neutral tonal separation for operational states.
- **Do** reflow long records and statistics within the viewport.
- **Do** keep owner chat mounted across navigation and preserve its drafts until send or logout.

### Don't:

- **Don't** reconstruct the Q, typeset the wordmark or inherit the former Marck Script/IBM Plex Sans identity for new web work.
- **Don't** turn each record into a raised card or add decorative eyebrows, glyph icons, glow or texture.
- **Don't** use a subtle divider as the sole boundary of an input or actionable control.
- **Don't** infer authorization, model availability, offline data availability or native release readiness from a visual example.
