# Sharebin — Design Guidelines

Reference: `Sharebin.dc.html` (interactive mockup) and `ui-mockup/` (screenshots below). Build to match these, not to reinterpret them.

## Identity
Personal, self-hosted file-sharing tool. Calm and utilitarian — not a marketing site, not enterprise document management. Mark: a simple bin shape with a downward "drop" arrow above the rim, paired with the "Sharebin" wordmark (Archivo, weight 600).

## Color

| Token | Hex | Use |
|---|---|---|
| Chalk | `#FBF7F2` | Card/surface background |
| Shell | `#F2EDE6` | Page background |
| Dune | `#E0DBCF` | Track fills, neutral badges, dividers |
| Charcoal | `#313131` | Primary text, primary buttons |
| Charcoal 62% | `rgba(49,49,49,.62)` | Muted/secondary text |
| Charcoal 14–18% | `rgba(49,49,49,.14–.18)` | Hairlines, input borders |
| Sky | `#7098C6` | Accent — links, primary actions on public pages, "public" state |
| Amber | `#C4923A` | "Password protected" state, "expiring soon" |
| Red | `#B24035` | Errors, "expired" state, destructive actions |

Only two background tones are used (Shell for page, Chalk for cards) — do not introduce more. Badges use each accent at ~12–16% opacity as background with the solid hue as text/icon color, never color alone (always paired with an icon + label).

## Type
Archivo (400 body / 500 medium for labels and buttons / 600 for headings and the wordmark). One typeface only. Scale used: 19px page/dialog titles, 15–16px card titles, 13.5–14.5px body/buttons, 12–12.5px metadata and pills, 11–11.5px fine print. No serif, no display sizes — this is app UI, not editorial.

## Shape & spacing
- 10–16px radius on cards and dropzones, 8px on buttons/inputs, full-round (pill) on filter chips and badges.
- Comfortable density: ~13–16px internal card padding, 8–10px gaps between list rows.
- Hairline (1px, `rgba(49,49,49,.1–.18)`) dividers only — no heavy borders or shadows beyond a very soft `0 1px 2px rgba(49,49,49,.06)` on cards.

## Iconography
Small monoline SVGs, `stroke-width` ~1.8–2, no fill, currentColor-style single hue per icon. Built from basic shapes only (circles, rects, lines, simple chevron/arrow paths) — no illustrative or decorative SVG. One icon per concept, reused everywhere: link/copy (overlapping rounded rects), lock (password), person (private/auth), clock (expiry), trash (delete), eye (view), search (magnifier), upload/download arrows.

## Access-state system
Every visibility/expiry state pairs a color, an icon, and a text label — never color alone.

| State | Color | Label |
|---|---|---|
| Public / unlisted | Sky | "Public" |
| Private / account-only | Neutral (Platinum/Dune) | "Private" |
| Password protected | Amber | "Password" + lock icon |
| Expiring soon (<48h) | Amber | "Expires in Xh" |
| Active expiry | Sky-tinted neutral | "Expires in X days" |
| Expired | Red | "Expired" |

## Navigation
Single consistent pattern at every width: a slim top bar (mark + avatar menu) and a bottom tab bar (Upload / Files) — no separate desktop nav pattern to keep behavior predictable across breakpoints. Public/recipient pages and auth pages drop the app chrome entirely and show only a centered card.

## Motion
Moderate, not decorative: 150–250ms ease transitions on hover/active/drag states, progress bars animate width, toasts slide up and fade. No looping or ambient animation.

## Copy tone
Direct, calm, short. Real examples from the mockup: "Drop files here or click to choose", "This link has expired", "Ask the sender for the password". Avoid exclamation points, cute wording on security actions (delete/expire/password), and any onboarding-style explanation.

## Components to reuse (see mockup for exact markup/styles)
File row, upload dropzone, upload queue item (progress → done/error), link-result row with copy button, visibility badge, expiry badge, filter/sort pill, confirm-inline delete (replaces row actions, no modal), toast, avatar menu.

## Screens captured in `ui-mockup/`
1. `01-login.png` — sign in
2. `02-upload-empty.png` — upload screen, ready state, visibility/expiry quick controls
3. `03-upload-with-links.png` — upload queue with completed links
4. `04-dashboard.png` — file list with search/filter/sort, storage quota
5. `05-public-available.png` — recipient view, downloadable file
6. `06-public-password.png` — recipient view, password gate
7. `07-public-expired.png` — recipient view, expired link

Open `Sharebin.dc.html` directly for the live, interactive version — it's more accurate than the stills for hover/focus/transition detail.
