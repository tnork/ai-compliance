# Design

Canonical visual system for the app (`web/app/globals.css`) and the policy generator. Use this file to keep both surfaces consistent.

## Theme

Light-first, institutional-evidence. Cool near-white paper body with a soft mint→sky wash in hero/brand moments; **navy** carries the "Committed" weight on dark sections (footer, packet bar, sidebar, auth). One saturated **emerald** accent = "verified," used sparingly. Cyan/blue are the logo's secondary support (focus rings, links, data lines). No dark mode; no cream/beige. Restraint over decoration — the design reads as a record, not a pitch.

Color strategy: **Restrained → Committed hybrid.** Light surfaces are tinted-neutral with one accent (Restrained); dark sections let navy carry 30–60% of the surface (Committed).

## Color

Hex values are authoritative (shipped tokens). Compose new surfaces from these — never reintroduce the retired yellow-lime (`#c9f24d`/`#d6ff5e`) or the retired silver/magenta DarkLogo.

### Neutrals / surfaces
- `--navy` `#0b1533` · `--navy-900` `#080f28` · `--navy-800` `#0f1c3f` · `--navy-700` `#16264d` · `--navy-600` `#20345f` — dark surfaces, primary buttons, headings.
- `--ink` `#141c2e` — body text on light.
- `--paper` `#f5f8fc` · `--paper-2` `#eaf0f8` — body / raised light surfaces.
- `--mint` `#edf7f1` · `--mint-2` `#e6f4ec` · `--hero-1` `#eaf6ef` · `--hero-2` `#f5f9fc` — hero/brand washes.
- `--lead` `#41506b` · `--muted` `#586277` — secondary/muted text on light (both ≥4.5:1 on paper).
- `--muted-dark` `#a9b7d0` · `--muted-dark-2` `#8496b5` — muted text on navy.
- `--white` `#fff`.

### Accent (emerald "verified" + logo blue/cyan)
- `--green` `#34e0a1` — bright emerald on navy (≈10.5:1); accents, live dots, `::selection`.
- `--green-bright` `#4aeaad` — hover.
- `--green-ink` `#08251a` — text on emerald buttons.
- `--green-deep` `#0a7d55` — **green text on light** (≈4.8:1 AA); the "4" wordmark, mono trust figures.
- `--green-pale` `#a9f0cf` — pale green text on navy.
- `--blue` `#3b9edb` · `--blue-ink` `#186099` (**blue text on light**, AA) · `--cyan` `#5bd0ec` (focus rings).
- The `--lime*` compat shims were **removed 2026-07-14** (no callers remained; `.btn-lime` retired too — use `.btn-green`). Never reintroduce yellow-lime. `--muted-2` `#7a8598` is a lighter muted-text tier. App `--paper-2` is `#eef2f8` (vs landing `#eaf0f8`) — landing values remain authoritative.

### Lines / status
- `--line` `#e0e7f1` — hairlines on light. `--line-2` `#d3ddea` (app, **solid** — a slightly stronger light divider, not the translucent-white token). On dark: `--line-dark` `rgba(255,255,255,.10)` · `--line-dark-2` `rgba(255,255,255,.16)`.
- `--lead` `#41506b` (app, 2026-07-14) — secondary text / form labels / neutral-badge ink on light; replaces the former hardcoded `#3a475e`/`#41506a`.
- Status (app): `--warn-*` amber (`#fef2d4`/`#f0d28a`/`#7a5600`) · `--ok-*` emerald (`#e6f7ef`/`--green-pale`/`--green-deep`) · **`--err-*` sober red (`#fdecea`/`#f5c6c2`/`#b3261e`, added 2026-07-14)** — the ONE red family app-wide (`.msg.err`, `.btn-danger`, `.btn-cancel`, `.badge.err`, diff `del`). **No red-alert scare styling** — errors are sober, not alarming (see anti-references).
- Semantic z-scale (app, real tokens since 2026-07-14): `--z-tip:40 · --z-backdrop:50 · --z-modal:51`.
- App utility classes (2026-07-14): `.t-key` (bold navy first-column table cell) · `.field label .sub` (muted in-label secondary text) · `.section-title`/`.section-sub` (mid-page section head) · `.badge.err` · `.skel` (route-transition skeleton shimmer, used by `web/app/(app)/loading.tsx`).
- App motion (2026-07-14, product register — state-conveying only): `.msg`/`.callout` fade-rise in 240–300ms (`riseIn`, keyframes end at natural state so paused animations still show content); `.tip-pop` 150ms on InfoTip; skeleton shimmer 1.4s; ALL disabled under `prefers-reduced-motion`. `tabular-nums` on `.stat .n`, table cells, `.kv td`, and `code`.

## Typography

- **Display / UI:** `Archivo` (400–900), system-ui fallback. One family, many weights (900 for headings/wordmark, 800 subheads, 600–700 UI).
- **Mono:** `JetBrains Mono` (500/700), `font-feature-settings:"ss01"` — eyebrows, trust figures, hashes, packet artifacts. Mono signals "machine record / evidence."
- Pair on the sans↔mono axis only. Never add a second sans.
- Headings: `letter-spacing:-.02em` to `-.035em` (display), `line-height:1.1`, `text-wrap:balance` on h1–h3.
- Hero h1: `clamp(40px,5.6vw,74px)` — under the 96px ceiling. Lead: `clamp(17px,1.55vw,20px)`, `max-width:52ch`.
- Body 15px / line-height 1.55; prose capped ~52–65ch.

## Layout & Spacing

- Container: `--maxw:1200px`, `padding:0 24px`.
- Radii: `--r-sm:9px` · `--r:14px` · `--r-lg:22px` · `--r-xl:28px` (app uses tighter `8/12/16`).
- Shadows: `--shadow:0 30px 80px -24px rgba(8,14,40,.5)` (dramatic, dark sections) · `--shadow-soft:0 18px 44px -20px rgba(20,35,70,.28)` (cards).
- App shell: `250px 1fr` grid, navy sticky sidebar; collapses to horizontal scroll-nav <820px.
- Responsive grids: `repeat(auto-fit,minmax(280px,1fr))` where possible; explicit `grid-3`/`grid-4` collapse 4→2→1 at 820/520px. No horizontal scroll 390–1280px.
- Z-scale is semantic and named: `--z-nav:20 · --z-menu:30 · --z-backdrop:50 · --z-modal:51`. Never arbitrary 999.

## Motion

- Single easing: `--ease:cubic-bezier(.16,1,.3,1)` (ease-out-expo family). No bounce/elastic.
- Buttons: `translateY(-1px)` on hover over ~.4–.5s; press `scale(.99)` fast (~.06s).
- Hero-only reveals (scaleX underline, staggered) — content is visible by default; reveals enhance, never gate visibility (headless/hidden-tab safe).
- `@media (prefers-reduced-motion: reduce)` kills transitions everywhere — already wired.

## Components

- **Buttons:** `.btn` base; `.btn-primary` (navy), `.btn-green` (emerald + green-ink), `.btn-ghost` (light), `.btn-ghost-dark` (on navy), `.btn-danger` (sober red, app). `.btn-sm` compact.
- **Brand wordmark:** flat two-tone vector shield ("The Ledger" — navy `#0f1c3f` shield, `--green` `#34e0a1` 2.5px keyline, three cyan record-lines, one emerald check; no gold/gloss/3D). The keyline is on **every** background (matches the approved design cover) — so `logo-primary.svg` (light) and `logo-reversed.svg` (navy) are now visually identical; both filenames kept for the existing references. Paired with the "AI Compliance" wordmark. Favicon `favicon.svg` (check-only shield, ≤24px).
- **Ampersand:** Archivo's `&` glyph is off-brand — render every visible ampersand in a standard sans instead via `.amp{font-family:Arial,Helvetica,sans-serif}` and wrap the character: `<span class="amp">&</span>` (JSX: `<span className="amp">&amp;</span>`). Applies to Archivo display/body text only — leave mono (`JetBrains Mono`) ampersands and `<option>` text (can't hold a span) as-is. The `.amp` rule lives in each inline `<style>`, `styles/site.css`, and `web/app/globals.css`. ⚠️ **Inside a flex or grid container (`.btn`, grid `<li>`, flex `<label>`), the `.amp` span becomes its own flex/grid item** — gaps double around it, or in a grid it wraps to a phantom row. Wrap the whole label in ONE extra span: `<span>BAA <span class="amp">&</span> self-host</span>`. This bug shipped on all three surfaces (pricing card, generator radio, three app buttons) before the 2026-07-09 design pass caught it.
- **Native controls:** checkboxes/radios take `accent-color:var(--navy)` (globals.css + policy generator) — never UA-default blue.
- **Social card:** `images/og-card.png` (1200×630, navy + emerald, "Prove you supervised your firm's AI use.") is the sitewide `og:image`; every static page carries og/twitter/canonical meta.
- **Cards / stats / badges / tables / forms:** defined in `web/app/globals.css` (`.card`, `.stat`, `.badge.ok|warn|neutral`, `.table`, `.field`/`.input`). Cards are white, 1px `--line`, soft shadow — used only where they're the right affordance; no nested cards.
- **Eyebrow:** mono, `--blue-ink` on light / emerald on dark, `letter-spacing:.05em`. Used as a deliberate brand device (evidence-label voice), not a reflexive kicker on every section.
- **Evidence artifacts:** hash-chain / packet visuals in mono are a signature pattern — reuse for "this is a record" moments.
- **Evidence surfaces (records / coverage / packet, added 2026-07-08):**
  - `code` renders in the brand mono globally (`globals.css`) — hashes/identifiers never fall back to browser monospace. Long hashes: `<code style={{fontSize:12}}>` with the global `word-break:break-all`.
  - `.kv` key-value table = the detail-record component (record detail "Supervision record"/"Tamper-evidence", packet "Integrity stamp"). Muted 220px label column; collapses to 140px on mobile.
  - **Verification banners:** `.msg.ok` with `role="status"` for "Chain verified … head hash" (the emerald moment of warmth); `.msg.err` with `role="alert"` for integrity failures. Failure language is factual, never alarmist.
  - **Integrity badges:** `.badge.ok` "Integrity verified"/"recomputed"; `.badge.warn` amber for DRAFT MAPPINGS and gap counts; `.badge.neutral` for n/a / "not evaluated". `warn` = attention/draft, never fear.
  - **Print:** global `@media print` in `globals.css` hides `.side`/`.btn`/`.no-print`, strips card shadows, and full-widths `.main` — the defense packet (and any record page) prints clean via the browser. Mark screen-only chrome with `.no-print`.
  - **Stat tiles** (`.stat`) are the metric pattern (dashboard + coverage); no bespoke hero metrics.
  - `.callout` (mint) carries firm-level action lists (coverage gaps) — institutional-calm, not warning-styled.

- **"Works With" strip (landing `#supported`, added 2026-07-11):** `.sup-chip` white logo pills in a seamless marquee (`.sup-track` holds two `.sup-set` copies, each animated `translateX(-100%)`; chip spacing is `margin-right`, never flex `gap`, or the loop jumps) with hover-pause + a keyboard pause button (WCAG 2.2.2); reduced-motion collapses to a static centered wrap. `.sup-map` is the register-style coverage card (3 columns, hairline dividers, mono column labels) with `.sup-tag` status pills: `LIVE` emerald / `CONNECTOR` blue / `POLICY` amber / `SOON` neutral — statuses stay honest, gaps visible. Logo assets: normalized white-bg PNGs in `images/integrations/` (h120, 2x of ~26px chip display); raw stock sources stay in `images/Integration Logos/`; regenerate per the `stock-logo-cleanup-pil` skill.

## Anti-slop guardrails (project-specific)

- No red-alert / scare styling — sober status only.
- No gradient text, no side-stripe accent borders, no glassmorphism-by-default.
- No cream/beige body; no retired yellow-lime; no DarkLogo silver/magenta variant. (The app's former olive `--ok-*` remnant was retired to emerald 2026-07-06 — `--ok-bg:#e6f7ef`, `--ok-ink:var(--green-deep)`.)
- Green accent stays scarce = it keeps meaning "verified." Don't flood surfaces with it.
