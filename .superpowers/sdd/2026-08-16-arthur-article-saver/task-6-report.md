# Task 6 — Cross-browser entrypoints and minimal UI

## Result

Implemented the WXT content and background entrypoints, accessible vanilla
options/status pages, and Chrome/Edge/Firefox manifest configuration. The
entrypoint tests use injected browser, storage, native-test, and extraction
facades; production uses WXT's unified `browser` API.

## RED → GREEN evidence

1. UI entrypoints
   - RED: `rtk pnpm test -- entrypoints/options/main.test.ts entrypoints/status/main.test.ts`
     failed because both missing `main.ts` entrypoints could not resolve.
   - GREEN: the same command passed with 14 files and 67 tests.

2. Background/content wiring
   - RED: `rtk pnpm test -- entrypoints/background.test.ts` failed because
     `entrypoints/content.ts` did not exist.
   - GREEN: the same command passed with 15 files and 70 tests.

3. WXT build discovery
   - Initial Chrome build reproduced WXT's duplicate `background` entrypoint
     error: WXT discovers co-located `*.test.ts` files under `entrypoints/`.
   - The supported `entrypoints:found` hook removes only those test files from
     packaging; Vitest still includes them. Chrome, Edge, and Firefox builds
     then passed.

## Verification

- `rtk pnpm test -- entrypoints` — passed: 15 files, 70 tests.
- `rtk pnpm typecheck` — passed; entrypoints are included in standard typecheck.
- `rtk pnpm build:chrome` — passed.
- `rtk pnpm build:edge` — passed.
- `rtk pnpm build:firefox` — passed.
- Generated Chrome, Edge, and Firefox manifests were checked for `storage`,
  `nativeMessaging`, both HTTP(S) patterns, absent `default_popup`, and the
  Firefox Gecko ID `arthur@olhapi.com`.
- `rtk git diff --check` — passed.

## Self-review against the brief

- Options load and validate stored absolute destinations, save only valid
  settings, and show typed host/folder connection results.
- Status details render untrusted storage values with `textContent`, never HTML.
- Content extraction messages forward the rendered `document` and
  `location.href` to `extractArticle`.
- Toolbar saves query the active tab, clear a prior popup, serialize per-tab
  saves, and delegate to the coordinator.
- The content script matches HTTP(S), WXT produces options/status pages, the
  normal action has no popup, and warning/error popup state remains owned by
  the existing `StatusController`.
- Options/status markup uses labels, buttons, `aria-live`, system fonts,
  light/dark color schemes, and visible keyboard focus.
