# Arthur marketplace listing handoff

## Canonical links

- Website: `https://olhapi.github.io/arthur/`
- Privacy policy: `https://olhapi.github.io/arthur/privacy/`
- Chrome Web Store: `https://chromewebstore.google.com/detail/arthur-%E2%80%94-article-saver/bfcgihgadankhhijhhdlkekecfmbihef`
- Firefox Browser Add-ons: `https://addons.mozilla.org/en-US/firefox/addon/arthur-article-saver/`
- Support: `oleh@olhapi.com` and `https://github.com/olhapi/arthur/issues`
- Source: `https://github.com/olhapi/arthur`
- License: MIT

The public store-link configuration lives in `site/source/site-config.js`.

## Listing copy

**Name:** Arthur — Article Saver

**Short description:** Save the rendered article you are reading as clean,
local Markdown.

**Long description:** Arthur saves the rendered article in the active tab as
clean Markdown. It works without an account, analytics, advertising,
telemetry, or remote backend. With the extension alone, Arthur downloads the
article as Markdown and leaves media as remote links. Its separately installed
optional macOS helper can instead write Markdown and browser-retrievable
attachments directly to the folder the user chooses.

## Permissions and privacy declarations

| Permission | Listing explanation |
| --- | --- |
| `activeTab` | Read the tab only after the user clicks Arthur to save it. |
| `storage` | Keep the user’s local Arthur preferences. |
| HTTP(S) host access | Read the selected article and browser-retrievable resources needed to preserve it. |
| `nativeMessaging` | Communicate with the separately installed optional helper for direct local saves. |
| `downloads` | Download Markdown when the helper is not installed or unavailable. |

Declare no remote code, no account, no analytics/telemetry/advertising, and no
collection, sale, or sharing of user data. The native helper receives article
content only during a save the user initiates. The complete privacy policy is
the public Pages URL above.

## Reviewer notes

- Arthur has one purpose: save the user-selected active article as Markdown.
- Native messaging is optional. The extension downloads Markdown if the helper
  is absent or disconnected before a save begins.
- The source package is this repository. Build with `pnpm install --frozen-lockfile`
  and the commands in `README.md`.
- Test the helper only on macOS: `pnpm native:install`, configure a destination
  in Arthur’s options page, and click the toolbar on an HTTP(S) article.
- Verify removal with `pnpm native:uninstall`; it removes only Arthur’s helper
  and browser manifests.

## Submission checklist

- [x] Configure the real Chrome Web Store URL in `SITE_CONFIG.stores.chrome`.
- [x] Configure the real AMO URL in `SITE_CONFIG.stores.firefox`.
- [ ] Capture the required marketplace screenshots from the released build.
- [ ] Reconcile every listing claim against `wxt.config.ts` and this document.
- [ ] Verify the published website and privacy-policy URLs.
- [ ] Publish a signed/notarized macOS helper asset and SHA-256 before enabling
      any release-installer command.

## Automatic store updates

The `Publish browser stores` GitHub Actions workflow submits an existing
`vMAJOR.MINOR.PATCH` tag to Chrome and Firefox. A pushed version tag starts it
automatically; `workflow_dispatch` can retry an existing tag. The workflow
checks out that tag, requires it to match `package.json` exactly, installs the
locked dependency graph, runs the TypeScript tests and typecheck, builds the
exact store archives, validates both upload ZIPs and the Firefox source archive,
and then submits both stores. Chrome uses API v2 `DEFAULT_PUBLISH`, so an approved submission is
published automatically. Firefox explicitly submits to its listed channel.

Configure the `browser-stores` GitHub environment with these secrets:

- `CHROME_PUBLISHER_ID`
- `CHROME_SERVICE_ACCOUNT_CLIENT_EMAIL`
- `CHROME_SERVICE_ACCOUNT_PRIVATE_KEY`
- `FIREFOX_JWT_ISSUER`
- `FIREFOX_JWT_SECRET`

The public Chrome and Firefox extension IDs are committed in the workflow and
checked by `scripts/release/verify-release.mjs`. For a local credential check,
copy `.env.submit.example` to ignored `.env.submit`, fill its placeholders, and
run `pnpm release:stores:dry-run`. Do not tag until that dry run succeeds.

Release a new version only after the full release gate passes:

```sh
pnpm verify
pnpm release:stores:dry-run
git tag -s vMAJOR.MINOR.PATCH
git push origin vMAJOR.MINOR.PATCH
```

Never reuse or move a published version tag. The workflow will not submit
version `0.1.1` merely because the workflow file is pushed; it runs only for a
new matching tag or an explicit manual dispatch.
