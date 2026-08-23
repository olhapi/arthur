# Arthur marketplace site design

## Purpose

Create Arthur's public GitHub Pages site: a responsive one-page product site
that gives Chrome and Firefox marketplace reviewers and users accurate,
verifiable information about the extension. The site must make direct local
vault saves easy to enable without suggesting that the optional native helper
is necessary to use Arthur.

Arthur's single purpose is to save the rendered article in the active browser
tab as Markdown. With the optional native helper, it writes that Markdown and
retrievable attachments to the user's selected local folder. Without the
helper, it downloads the Markdown locally.

## Scope

The initial public release supports Chrome and Firefox only. It does not
display an Edge install button, claim Edge marketplace availability, add
accounts, analytics, telemetry, advertising, a remote backend, or automated
updates.

The design includes:

- a static GitHub Pages site at `https://olhapi.github.io/arthur/`;
- a stable, accessible privacy-policy URL at
  `https://olhapi.github.io/arthur/privacy/`;
- Chrome and Firefox marketplace call-to-action slots, enabled only after
  their real listing URLs are configured;
- an optional native-helper installation flow using a versioned GitHub Release
  asset, a published SHA-256 checksum, and a copyable terminal command;
- installer source, an uninstall command, and support routes;
- a private marketplace handoff document that keeps listing metadata and
  reviewer instructions aligned with the shipped behavior; and
- a SHA-pinned GitHub Pages deployment workflow.

Publishing the store listings, signing/notarizing a macOS release asset, or
creating a new GitHub Release is outside this site's implementation. The site
must never advertise an installer or store listing that does not exist.

## Site architecture

The site is dependency-free static HTML, CSS, and minimal JavaScript under a
dedicated site directory. This keeps the marketing surface independently
auditable and suitable for GitHub Pages without adding runtime code to the
extension.

The public structure is:

```text
site/
  index.html             # product page
  privacy/index.html     # stable privacy policy
  assets/                # Arthur icon and local UI artwork only
  styles.css             # responsive, reduced-motion-aware styles
  site.js                # copy command and store-link rendering only
```

One central public configuration object supplies store URLs, current native
helper release metadata, checksum URL/value, and source URLs. A missing or
explicitly disabled store URL renders an honest unavailable state rather than
a link. The page has no third-party font, analytics, script, image, or remote
code dependency.

The page order is:

1. Hero with Chrome and Firefox install calls to action.
2. "Two ways to save" comparison: download-only works immediately; direct
   local vault saves and attachments require the optional helper.
3. Three-step setup: install the extension, optionally install the helper,
   choose a destination, then save from the toolbar.
4. Optional helper card with a copyable terminal command, a plain-language
   description of its bounded behavior, requirements, source link, checksum
   explanation, and uninstall command.
5. Permissions, explained in user terms and mapped exactly to the manifest.
6. Privacy summary linking to the complete privacy policy.
7. Help, removal instructions, support email, GitHub issue tracker, source,
   and license.

## Optional native-helper delivery

The release contains the native helper plus only the browser manifests needed
to register it. The installer command downloads a selected versioned release
asset, verifies the expected SHA-256 before installation, and invokes the
bounded Arthur installer. It installs neither a browser extension nor an
unrelated dependency, does not use elevated privileges, does not self-update,
and performs no network request after the chosen release is downloaded.

The installer is opt-in. The page makes the fallback behavior visible before
the command: if the helper is absent or disconnects before a save begins,
Arthur downloads Markdown with remote media links; it does not write into the
configured folder or download attachments.

The uninstall command is adjacent to installation and removes only Arthur's
native binary and its browser manifests. It must not remove browser profiles,
vault contents, or parent support directories.

The command must not be presented until the release asset and its checksum
are public. Before then, the helper card states that the release is not yet
available and offers the documented source-install command instead.

## Marketplace and privacy contract

The site and the submitted listings use identical factual statements:

- Arthur has a single purpose: saving the user-selected active article.
- It supports macOS. The native-helper feature additionally requires its
  explicit installation; the extension-only Markdown-download path does not
  depend on the helper.
- Arthur has no account, analytics, advertising, telemetry, remote backend,
  or sale/sharing of user data.
- Article content, local destination preferences, and downloaded/saved files
  remain on the user's device. The helper receives article content only during
  a user-triggered save.
- User control is explicit: save is a toolbar action; the helper is optional;
  destinations are selected by the user; the extension and helper can each be
  removed by the user.

The manifest permission explanations are:

| Permission | User-facing reason |
| --- | --- |
| `activeTab` | Read the tab only after the user clicks Arthur to save it. |
| `storage` | Keep the user's local Arthur preferences. |
| HTTP(S) host access | Read the selected article and browser-retrievable resources needed to preserve it. |
| `nativeMessaging` | Communicate with the separately installed optional helper for direct local saves. |
| `downloads` | Download Markdown when the helper is not installed or unavailable. |

The privacy policy includes contact information (`oleh@olhapi.com`), data
handling, local retention, native-message boundary, controls/removal, policy
updates, and links back to the site. It may be linked from every marketplace
listing even when the marketplace does not require it.

The marketplace handoff includes title, short and long descriptions, category,
support email and website, privacy-policy URL, source repository, license,
permissions rationale, no-data/remote-code declarations, reviewer test steps,
and required screenshots/assets. It is maintained with the manifest and site
configuration whenever behavior changes.

## Error handling and accessibility

The page must not fail silently. Missing release or marketplace configuration
is represented in visible text. Clipboard failure leaves the complete command
selectable and announces a concise status without blocking installation.
External links are labelled with their destination; mail and issue links are
usable without JavaScript.

The content is semantic HTML with one `h1`, logical heading order, visible
keyboard focus, descriptive links, adequate color contrast, no color-only
meaning, and a usable layout at narrow widths. Animation is decorative only
and disabled or reduced for `prefers-reduced-motion`.

## Deployment and verification

GitHub Pages deploys the static site only after a local integrity check. The
workflow pins every third-party or GitHub Action reference to an immutable
commit SHA, per repository policy. The deployment source does not include
extension packages, native build output, credentials, or development caches.

Verification covers:

- structural checks for the two public pages, required sections, stable
  privacy link, configured store-link states, and local-only assets;
- a static-server smoke test for the primary and privacy URLs;
- keyboard, responsive, and reduced-motion checks;
- link and installer metadata validation, including a test that a visible
  checksum is required before displaying a release install command; and
- a manual final check that published URLs, release checksum, listing claims,
  and the current manifest permissions agree.

## Acceptance criteria

The implementation is ready when a visitor can understand Arthur's purpose,
install the extension from Chrome or Firefox once their real listing URLs are
configured, distinguish the no-helper fallback from the optional direct-save
path, find accurate privacy/support/removal information, and install the
helper only through a checksum-verified release flow. Marketplace reviewers
can use the handoff document and public policy URL to reconcile every claim
with the manifest and source.
