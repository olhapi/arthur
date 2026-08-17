# Arthur extension icon design

## Goal

Replace the generic browser puzzle-piece icon with a recognizable Arthur mark
in Chrome, Edge, Firefox, and Zen.

## Visual

The approved mark is “Saved article”: a violet rounded square, a white
document, and a small gold confirmation check. Its geometry is intentionally
simple enough to remain legible at 16px.

## Assets and manifest wiring

One version-controlled SVG source will generate PNG assets at 16, 32, 48, and
128px. The manifest will declare those files both as extension icons and as
the toolbar action's default icons. WXT will map the action to Firefox MV2's
`browser_action` while retaining the same files.

## Verification

The build smoke will require every icon mapping and image file for Chrome,
Edge, and Firefox. Focused tests, TypeScript checking, and all three builds
must pass before the icon change is committed.
