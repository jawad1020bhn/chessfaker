# Felt — Material 3 Expressive design system

Greenfield UI for the Chess Coach side panel. The previous layout is not a source.

## Product jobs

1. Read the recommended move in under a second.
2. Know whose side is being coached.
3. Judge evaluation and analysis quality without implementation jargon.
4. Change play style and effort as goals, not engine knobs.
5. Trust provider health without leaving the coach surface.

## Design decisions (this revision)

**The hero shows the move, nothing else.** The user picked the style in
settings, so the move line never repeats it — "Ultra Super Aggressive Attack
choice:" and its siblings are gone for good. `hint-engine` now returns the
hero line and a separate `captions` array (`{ kind, label, text }`), and the
panel renders the captions in their own rail outside the hero — the
"Why this move" section with staggered rows and expressive shape-play icons.

**Trust is whispered, not tagged.** The ENGINE source badge and the
VERIFIED FEN chip are deleted. Analysis quality still shows as prose in the
Position facts card; the status row communicates through its existing dot,
loader, and a state tint on the turn line.

**Selection is a sliding pill, everywhere.** All radio-style groups (side
selector, Engine/Human, quality, candidate lines) share one segmented-control
system: a single indicator pill springs between options on the spatial curve
(transform + width only, GPU-friendly). The White/Black pill carries piece
identity — light pill for White, dark pill for Black — and morphs color while
it travels. Arrow keys rove per the APG radiogroup pattern.

**Switches run the full M3 motion recipe.** Thumb grows 16 → 24px while it
travels, stretches on press, a check pops inside when on, and a 40px state
layer blooms on hover/focus/press. Style choice cards morph their corner
radius (lg → xl) and pop a check when selected.

**Balance and Last move are fully wired, one layer to the next.** Earlier the
Expressive CSS for both tiles existed while the markup still spoke the legacy
`.md-card .md-eval` dialect: `#eval-score` and the fulcrum were missing from
the HTML, the hidden `#eval-bar-black` dual-bar remnant was still being
transformed, and `--eval-pct` was written to the bar instead of the tile the
fulcrum inherits from. The HTML, CSS, and JS now implement one contract each,
and `tests/panel-wiring.test.js` locks the three layers together so a future
edit cannot silently disconnect them again. The win-probability breakdown
(`You 52% · Opp 48%`) is a pair of opposite-identity chips inside the meter
itself — each chip inverts against the half it sits on (inverse-surface over
White's light fill, lightest-surface over Black's inverse-surface remainder,
with a hairline ring) so the figures stay legible on both halves in both
themes, mirroring the light/dark piece identity — and it never competes
with the ribbon side labels, which carry the +/- score.

## Expressive tactics used

| Tactic | Application |
|---|---|
| Variety of shapes | Extra-large hero, blob caption icons, asymmetric FAB, morphing brand mark |
| Rich color | HCT-style roles from a felt-green seed; tertiary amber for urgency |
| Emphasized type | Display-small-emphasized for the move; label-md for wayfinding |
| Contain for emphasis | Primary-container hero; surface-container-lowest caption rail |
| Spatial springs | Sliding selection pills, switch thumb travel, staggered entrances |
| Flexible components | Segmented controls, choice cards, switches, FAB |
| Hero moment | The move is the only display type on the canvas — ever |
| Motion as identity | Hero blob follows the current container's on-color per mode |

## Tokens

Color roles follow M3 pairing: `primary` / `on-primary`, `primary-container` /
`on-primary-container`, plus secondary, tertiary, error, and the
surface-container ladder. Piece-identity neutrals (`--md-piece-light`) are
theme-independent by design.

Type roles: display-sm-emphasized, headline-sm, title-large-emphasized,
title-sm, body-md, label-lg, label-md.

Shape: xs 4 → xl-inc 36 → full.

Motion: spatial spring `cubic-bezier(0.34, 1.4, 0.64, 1)` for position/shape;
effects curve for color/opacity.

## Components

- **App bar** — identity + animated White/Black segmented control + tonal settings icon
- **Status row** — morphing loader while analyzing; turn line with state tint
- **Hero** — primary container; switches to secondary (human) or tertiary (ultra); displays only the SAN move
- **Caption rail** — "Why this move": idea, capture/sacrifice, cost, risk, king-hunt, balance posture
- **Squares lockup** — piece glyph + from/to square chips inside the hero
- **Balance tile** — content-first scorecard: kicker + prose description;
  a 32dp dual-identity ribbon (white fill from the left, inverse-surface remainder)
  with a morphing fulcrum riding the split; White/Black piece-identity labels;
  4-state lifecycle (`empty → loading → data → error/stale`) with skeleton shimmer;
  lean (you / opp / even) retints the whole tile and re-roots its corner radii
- **Last move verdict tile** — the rate and judgment as the hero: role container
  (primary for good moves, tertiary for inaccuracy/mistake, error for blunder),
  organic radius that sharpens as the verdict worsens, move identity line
  (`You played Nf6` / `Opponent played exd5`), emphasized verdict word with a quieter
  annotation symbol, win-chance swing metric, morphing blob accuracy ring with a
  large accuracy figure + `/ 100` cap, and an explicit empty ghost state
  (`Play a move to see how it rated`) before moves are classified
- **Banners** — primary / tertiary / error containers with leading icons
- **Fact list** — opening, phase, quality, material, natural play
- **FAB** — refresh; morphs toward a circle on hover
- **Settings sheet** — full-screen surface; style as choice cards; quality as segmented control; sources as switches; slides up on open
- **Snackbar** — inverse surface, 3:1 contrast

## Accessibility

- 44px minimum targets on icon buttons, FAB, switches (52×44 input overlay)
- Color only on paired roles
- Focus-visible uses secondary, 3px
- `prefers-reduced-motion` disables springs
- Settings and shortcuts are modal dialogs with focus trap and Escape
- All segmented radiogroups support arrow-key roving (APG)

## Quality pass (this revision)

Fixes that close the gaps between the documented system and the shipped UI.

- **Role tokens are now consumed, not just declared.** `--balance-role-muted`
  and `--verdict-role-muted` were defined but every consumer used a hardcoded
  `on-surface-variant` / `on-surface`, leaving grey stragglers over colored
  containers when a tile leaned or a verdict landed. Kickers, descriptions,
  the stale badge, mover line, metric, verdict word and the accuracy ring
  now all read the tile's own `-role-fg` / `-role-muted` tokens.
- **Meter chips are legible on both halves in both themes** (see Balance).
- **Hero display type is a single canonical token.** The redundant
  `md-typescale-display-sm-em` class was removed from the move line (it was
  silently overridden by `.hint-text`'s clamp); the hero now renders at a
  true display scale, `clamp(1.75rem, 7vw, 2.25rem)`.
- **Dead wires removed.** `--hint-accent` (JS wrote it, CSS never read it),
  `--hero-shift`, the empty `:has()` rule, and the `--accent-gold /
  --accent-aggressive / --accent-super-ultra` aliases that only fed it.
  `--accent-yellow` is now a token reference (`tertiary`) so the correlation
  stat keeps contrast in dark mode.
- **Style-scoped controls actually hide.** Author `display: flex` was
  overriding the UA `[hidden]` rule, so the Early King Hunt row stayed
  visible (disabled) outside Ultra attack. `.md-switch-row[hidden]` now
  wins, matching the existing `.md-idea[hidden]` precedent.
- **Skeleton shimmer is wired.** The `.md-skeleton` rule existed but no state
  used it; the Balance loading state now renders a shimmer placeholder in
  the description line for fresh positions (keeps prior scores on refresh).
- **Fulcrum travel is clamped** (5–95%) so a one-sided score never pushes
  the 22px marker off the edge of the meter.
- **Motion is symmetric.** The settings sheet and the shortcuts dialog now
  animate out (settle on the effects curve) as well as in (rise on the
  spatial spring) — no hard cuts on either side; the status dot fades
  between states instead of snapping.
- **Interaction + keyboard polish.** The dialog scrim closes the shortcuts
  sheet (it previously did nothing); the shortcuts dialog traps Tab and
  restores focus on close; the hidden settings `<select>`s and the
  human-mode checkbox are no longer tabbable; the style choice cards got
  APG roving (arrow keys) and roving tabindex like every other radiogroup;
  segmented items grew to a 40px hit height; the fair-play warning banner
  clears itself once analysis succeeds again.
- **Coherence nits.** Settings section headings are `on-surface` like the
  canvas headings (brand green is reserved for states, choices and the
  hero); the toast joined the organic radius family (it was the only 4px
  corner in the system); diagnostics figures are tabular-nums; the turn
  line's `pending` state got its outline tint to complete the
  verified / partial / pending story.

## Dev preview

`preview/index.html` boots the real side panel against a mocked `chrome.*`
runtime (one canned Scholar's-mate position; no network). Serve the repo root
over any static server and open `/preview/`. Not shipped in the extension.
