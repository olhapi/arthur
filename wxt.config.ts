import { defineConfig } from "wxt";

import { CHROMIUM_PUBLIC_KEY_DER_BASE64 } from "./scripts/native-host/identity.mjs";

export default defineConfig({
  zip: {
    excludeSources: [
      "native/target/**",
      "native/src/bin/arthur-native-acceptance-host.rs",
      "node_modules/**",
      ".output/**",
      ".wxt/**",
      "coverage/**",
      "dist/**",
      ".turbo/**",
      "**/*.zip",
    ],
  },
  hooks: {
    // WXT discovers every TypeScript file beneath entrypoints. Keep the
    // required co-located Vitest files out of the packaged extension.
    "entrypoints:found": (_wxt, entrypoints) => {
      for (let index = entrypoints.length - 1; index >= 0; index -= 1) {
        if (entrypoints[index]?.inputPath.endsWith(".test.ts")) entrypoints.splice(index, 1);
      }
    },
  },
  manifest: {
    key: CHROMIUM_PUBLIC_KEY_DER_BASE64,
    action: {},
    permissions: ["activeTab", "storage", "nativeMessaging"],
    host_permissions: ["http://*/*", "https://*/*"],
    browser_specific_settings: {
      gecko: {
        id: "arthur@olhapi.com",
        data_collection_permissions: {
          required: ["none"],
        },
      },
    },
  },
});
