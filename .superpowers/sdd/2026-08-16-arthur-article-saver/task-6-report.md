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

## Review fix round 1

### RED → GREEN evidence

- Registered content transport: RED proved the runtime listener had no callback
  response transport; GREEN registers a listener that calls `sendResponse` and
  returns literal `true` for extraction requests.
- Status retry: RED modeled browser-action popup interception and proved neither
  the popup nor background offered a retry; GREEN adds an accessible Retry save
  action using a callback-backed `retry_save` background message.
- Native validation: RED used `requestSubmit()` after correcting an invalid path
  and remained blocked by stale custom validity; GREEN clears it on input.
- Native-session serialization and status isolation: RED started two saves for
  different tabs over one client and exposed unscoped stored detail; GREEN uses
  one global in-flight save and stores/loads actionable detail by tab ID.
- Connection classification: RED showed a post-hello destination failure had no
  testable typed boundary; GREEN keeps the host available and reports only the
  folder check as failed.

### Verification

- Focused reviewed regressions pass as part of 15 files and 75 tests.
- Standard TypeScript compilation includes and passes all production entrypoints.
- Chrome MV3, Edge MV3, and Firefox MV2 builds pass.
- Generated manifests retain `storage`, `nativeMessaging`, HTTP(S) access, no
  default popup, and Firefox ID `arthur@olhapi.com`.
- Light error text `#b42318` on `#ffffff` measures `6.57:1`; dark error text
  `#ffdad6` on the explicit `#121212` background measures `14.50:1`.

### Review checklist

- Extraction results cross the real runtime listener through a supported
  callback response instead of a plain return value.
- A warning/error popup has an intentional retry path even though its presence
  suppresses `action.onClicked`.
- Corrected destinations can pass native form validation and save.
- Only one save can own the shared `NativeClient`; stored status is scoped and
  filtered to the active tab before rendering.
- Host handshake and destination access failures remain distinct typed results.
- Both light and dark error colors exceed WCAG AA contrast for normal text.

## Review fix round 2

### RED → GREEN evidence

- Retry identity/trust RED proved the popup message did not carry a tab ID,
  followed browser focus, and accepted content-script/foreign/malformed
  messages. GREEN requires the exact `{ type: "retry_save", tabId }` shape,
  validates the sender ID plus exact extension `status.html` URL, and resolves
  the requested tab through `tabs.get(tabId)`.
- Retry completion RED proved closed/malformed tabs were reported as success,
  popup/coordinator rejection left the callback channel hanging, and a busy
  coordinator reported success without starting work. GREEN returns a typed
  success or `save_busy`, `tab_unavailable`, or `save_failed` response for every
  accepted request. The popup keeps its captured tab ID, re-enables Retry save
  in `finally`, and renders rejected/skipped retries as failures.
- Status retention RED proved one shared object still discarded tab A when tab
  B wrote. GREEN stores `arthur-status:<tabId>` records, loads only the active
  popup tab's exact key, clears stale records when saving succeeds/restarts,
  and removes a record when its tab closes. Records are therefore bounded to
  actionable failures for live tabs.

### Verification

- Focused RED suites failed in all reviewed branches before implementation.
- GREEN `rtk pnpm test -- entrypoints` passes 15 files and 84 tests.
- Standard typecheck and Chrome, Edge, and Firefox builds pass.
- Generated manifest assertions and `rtk git diff --check` pass.
