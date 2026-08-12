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
edit cannot silently disconnect them again.

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
- **Balance tile** — the score is the only display type on the tile; kicker +
  player-perspective score headline + prose description; a 32dp dual-identity
  ribbon (white fill from the left, inverse-surface remainder) with a morphing
  fulcrum riding the split; White/Black piece-identity labels; lean
  (you / opp / even) retints the whole tile and re-roots its corner radii
- **Last move verdict tile** — the surface *is* the judgment: role container
  (primary for good moves, tertiary for inaccuracy/mistake, error for blunder),
  organic radius that sharpens as the verdict worsens, emphasized verdict word
  with a quieter annotation symbol, win-chance swing metric, and a morphing
  blob accuracy ring with a prominent accuracy figure + `acc` cap
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

## Dev preview

`preview/index.html` boots the real side panel against a mocked `chrome.*`
runtime (one canned Scholar's-mate position; no network). Serve the repo root
over any static server and open `/preview/`. Not shipped in the extension.
