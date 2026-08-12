# Felt — Material 3 Expressive design system

Greenfield UI for the Chess Coach side panel. The previous layout is not a source.

## Product jobs

1. Read the recommended move in under a second.
2. Know whose side is being coached.
3. Judge evaluation and analysis quality without implementation jargon.
4. Change play style and effort as goals, not engine knobs.
5. Trust provider health without leaving the coach surface.

## Expressive tactics used

| Tactic | Application |
|---|---|
| Variety of shapes | Extra-large hero, full chips, asymmetric FAB, morphing brand mark |
| Rich color | HCT-style roles from a felt-green seed; tertiary amber for urgency |
| Emphasized type | Display-small-emphasized for the move; label-md for wayfinding |
| Contain for emphasis | Primary-container hero; surface-container-low supporting cards |
| Spatial springs | FAB hover morph, hint enter, shape-idle brand mark |
| Flexible components | Connected button groups, choice stack, switches, FAB |
| Hero moment | The move is the only display type on the canvas |

## Tokens

Color roles follow M3 pairing: `primary` / `on-primary`, `primary-container` / `on-primary-container`, plus secondary, tertiary, error, and the surface-container ladder.

Type roles: display-sm-emphasized, headline-sm, title-large-emphasized, title-sm, body-md, label-lg, label-md.

Shape: xs 4 → xl-inc 36 → full.

Motion: spatial spring `cubic-bezier(0.34, 1.4, 0.64, 1)` for position/shape; effects curve for color/opacity.

## Components

- **App bar** — identity + connected White/Black group + tonal settings icon
- **Status row** — morphing loader while analyzing; assist chip for FEN trust
- **Hero** — primary container; switches to secondary (human) or tertiary (ultra)
- **Balance card** — single-ended meter (white fill from the left)
- **Banners** — primary / tertiary / error containers
- **Fact list** — opening, phase, quality, material, natural play
- **FAB** — refresh; morphs toward a circle on hover
- **Settings sheet** — full-screen surface; style as choice cards; quality as button group; sources as switches
- **Snackbar** — inverse surface, 3:1 contrast

## Accessibility

- 44px minimum targets on icon buttons, FAB, switches
- Color only on paired roles
- Focus-visible uses secondary, 3px
- `prefers-reduced-motion` disables springs
- Settings and shortcuts are modal dialogs with focus trap and Escape
