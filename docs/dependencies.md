# Dependency due diligence

Checked on 2026-08-16 before installation with the required `pnpm view
<package> version time deprecated` registry query and the public GitHub
repository plus Security Advisories endpoint. No selected package returned a
registry `deprecated` field.

| Package | Exact version | Repository | Latest activity | Advisory result for selected pin | Purpose | Decision |
| --- | --- | --- | --- | --- | --- | --- |
| `@mozilla/readability` | `0.6.0` | https://github.com/mozilla/readability | 2026-08-04T00:16:05Z | GHSA-3p6v-hrg8-8qj7 affects `< 0.6.0`; pin is outside range | extract readable article content | keep |
| `dompurify` | `3.4.13` | https://github.com/cure53/DOMPurify | 2026-08-15T11:59:23Z | 23 historical advisories; newest GHSA-55q2-fjhq-7xh7 affects `<= 3.4.12`; pin is outside every listed range | sanitize saved HTML | keep |
| `turndown` | `7.2.4` | https://github.com/mixmark-io/turndown | 2026-06-23T22:17:20Z | no published repository advisories | convert HTML to Markdown | keep |
| `zod` | `4.4.3` | https://github.com/colinhacks/zod | 2026-08-15T15:54:15Z | no published repository advisories | validate shared contracts | keep |
| `wxt` | `0.21.4` | https://github.com/wxt-dev/wxt | 2026-08-14T00:32:30Z | no published repository advisories | extension build tooling | keep |
| `typescript` | `7.0.2` | https://github.com/microsoft/TypeScript | 2026-08-14T19:07:48Z | no published repository advisories | static type checking | keep |
| `vitest` | `4.1.10` | https://github.com/vitest-dev/vitest | 2026-08-14T15:45:58Z | direct Vitest GHSA-5xrq-8626-4rwp affects `>= 4.0.0, < 4.1.0`; pin is outside; browser-only advisory GHSA-p63j-vcc4-9vmv is patched in `@vitest/browser@4.1.10` | contract tests | keep |
| `happy-dom` | `20.11.2` | https://github.com/capricorn86/happy-dom | 2026-08-12T21:57:59Z | newest GHSA-w4gp-fjgq-3q4g affects `<= 20.8.8`; pin is outside every listed range | Vitest DOM environment | keep |
| `@types/node` | `26.2.0` | https://github.com/DefinitelyTyped/DefinitelyTyped | 2026-08-15T15:02:18Z | no published repository advisories | Node typings | keep |
| `@types/turndown` | `5.0.6` | https://github.com/DefinitelyTyped/DefinitelyTyped | 2026-08-15T15:02:18Z | no published repository advisories | Turndown typings | keep |

`tsx` is omitted because the accepted design has no direct-TypeScript runtime
script. `date-fns` is omitted because it has no date-formatting requirement.
`fflate` is omitted because the accepted design has no ZIP fallback.
