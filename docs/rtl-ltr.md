# RTL / LTR architecture

Arabic lays out right-to-left, English left-to-right. This document explains how
one component tree serves both without a mirrored stylesheet and without a
single `dir === 'rtl' ? … : …` conditional.

---

## The rule

**No component contains a physical-side utility.** No left/right margins,
paddings, offsets, borders, rounding or text alignment.

| Instead of | Use | Compiles to |
|---|---|---|
| `ml-*` / `mr-*` | `ms-*` / `me-*` | `margin-inline-start` / `-end` |
| `pl-*` / `pr-*` | `ps-*` / `pe-*` | `padding-inline-start` / `-end` |
| `left-*` / `right-*` | `start-*` / `end-*` | `inset-inline-start` / `-end` |
| `text-left` / `text-right` | `text-start` / `text-end` | `text-align: start` / `end` |
| `border-l` / `border-r` | `border-s` / `border-e` | `border-inline-start` / `-end` |
| `rounded-l-*` / `rounded-r-*` | `rounded-s-*` / `rounded-e-*` | `border-start-*-radius` |
| `float-left` / `float-right` | `float-start` / `float-end` | `float: inline-start` / `inline-end` |

Tailwind v4 compiles all of these to CSS logical properties. The browser
resolves them against `dir`, so the same markup is correct in both languages.

Physical properties remain correct for anything with no reading direction — a
box shadow, a rotation, a vertical offset.

---

## Why this is enforced by a machine

A physical-side utility looks **perfect** in English. It is wrong only for
Arabic readers. Nobody reviewing the code in English can see it, and nobody
testing in English can see it. It is exactly the class of bug that survives
review and ships.

So it is checked three ways:

1. **Source scan** — [`tests/i18n/rtl.test.ts`](../tests/i18n/rtl.test.ts) reads
   every `.ts`/`.tsx` file under `src/` and fails on any forbidden token, naming
   the file, the line and the logical replacement.

2. **Built stylesheet scan** — the same file asserts against the compiled CSS in
   `.next/static/css/`. This catches what the source scan cannot: a Tailwind
   preflight rule, a dependency's styles, or a class name the scanner picked up
   from somewhere unexpected.

   That third case is not hypothetical. The shipped bundle once contained a
   physical padding and a physical text alignment because Tailwind's scanner had
   read those class names **out of a code comment** explaining that they were
   forbidden. Scanning is now scoped to `src/` via `@source`, the comments no
   longer spell out literal class names, and the assertion is against the build
   output. Current state: **zero** physical-direction properties in the shipped
   CSS.

3. **Geometry, end to end** — Playwright asserts the sidebar is physically on
   the correct side of the viewport. `dir="rtl"` on `<html>` proves nothing on
   its own; a stylesheet full of physical properties would still put the sidebar
   on the left for an Arabic reader.

---

## Direction is set on the server

`src/app/[locale]/layout.tsx` reads the locale from the URL segment and emits:

```tsx
<html lang={locale} dir={config.direction}>
```

No client-side effect flips `dir` after hydration, so there is no flash of
mis-directed layout. Every logical property resolves correctly during server
rendering, so the HTML that arrives is already laid out right.

---

## Content direction vs. UI direction

The two can differ, and a chat interface is where that becomes obvious. Someone
using the Arabic interface may paste an English policy question; the Knowledge
agent answers in the language it was asked in.

So each message bubble carries its own `dir`, detected from its first strong
character:

```tsx
<div dir={detectDirection(message.content)}>{message.content}</div>
```

Free-text inputs use `dir="auto"` and let the browser decide per content.
Fields that are always Latin — email, URL, budget amount, dates — are pinned
with `dir="ltr"` plus `.force-ltr`, so the caret and the text do not reorder
inside an Arabic form.

---

## Bidi isolation

A Latin run inside Arabic prose reorders under the Unicode bidirectional
algorithm. "HR Policy.pdf" can render with the extension displaced, which reads
as a corrupted filename.

Two tools, used throughout:

- `.bidi-isolate` (`unicode-bidi: isolate`) for filenames and display names.
- `.force-ltr` (`direction: ltr; unicode-bidi: isolate; text-align: start`) for
  technical values: email addresses, Meta campaign IDs, correlation references,
  hex, URLs.
- `isolate(text)` in `src/i18n/format.ts` wraps a string in U+2068/U+2069 for
  contexts where a CSS class is not available.

---

## Direction-sensitive content

Layout is handled by logical properties. What remains is content whose *meaning*
is directional — an arrow, a chevron, a megaphone, a play triangle. Those carry
`data-flip-rtl`, and one rule mirrors them:

```css
[dir='rtl'] [data-flip-rtl] { transform: scaleX(-1); }
```

Applied deliberately, per icon, not globally: a clock, a checkmark, a document
and a logo must **not** mirror.

The progress bar fills from the reading start using `inline-size` rather than a
transform, so it grows rightward in English and leftward in Arabic with no
conditional.

### Charts

The analytics chart is hand-drawn SVG rather than a charting library, and
direction is the main reason. Every mainstream charting library assumes a
left-to-right time axis and cannot express the RTL reading of "time moves
forward" without a fight. Here the bars are flex children, so the flow does it
for free. The same data is emitted as a visually-hidden `<table>` so the chart
is not a picture with nothing behind it.

---

## End-to-end coverage

[`tests/e2e/bilingual.spec.ts`](../tests/e2e/bilingual.spec.ts) runs three
projects — `arabic-rtl`, `english-ltr`, `mobile-rtl` — each with its own browser
locale so `Accept-Language` negotiation is exercised for real. **74 tests
passing.**

Per project:

| Check | |
|---|---|
| Bare `/` sends the browser to its own language | §5 |
| A locale-prefixed link overrides the browser preference | shared links |
| Every public page renders with correct `lang`, `dir` **and computed style** | |
| All ten authenticated pages likewise, each verified by its own `<h1>` | §44 |
| No page scrolls horizontally, in either direction | §41 |
| The sidebar is geometrically on the reading edge | the assertion `dir` alone cannot make |
| The language switcher is reachable **before** signing in | someone who cannot read the form must still be able to fix it |
| Switching language navigates and flips direction | |
| The preference survives navigation and reload | §5 |
| The campaign wizard states campaigns are created paused | in both languages |
| The Creative Studio explains video is unavailable | |
| Campaign performance is reported unavailable, not zero | |
| A skip link is the first thing Tab reaches | §40 |
| Every form control has an accessible name | §40 |
| Exactly one `<h1>` per page | §40 |

Those last three found a real defect: the Knowledge workspace had **no `<h1>`
at all**, having been built as a bare three-column layout. Screen-reader users
had no page identity and the document outline was broken.

The accessible-name check found another: `Field` wired its control by cloning
its child, so whenever a field needed a wrapper — the password reveal button —
the `id` and every `aria-*` landed on the wrapper `<div>` and the `<label for>`
pointed at a non-labelable element. Fixed structurally by moving form controls
to a `'use client'` module where `Field` publishes its wiring through React
context, so no arrangement of markup can break the association.

---

## Adding a component

1. Use logical utilities only. The source scan will tell you if you slip.
2. Give any directional glyph `data-flip-rtl`; leave non-directional ones alone.
3. Isolate any Latin run that will sit inside Arabic prose.
4. Add the page to the `PAGES` array in the E2E spec — it is then checked in
   both directions automatically.
