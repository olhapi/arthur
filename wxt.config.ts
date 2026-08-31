import { defineConfig } from "wxt";
import tailwindcss from "@tailwindcss/vite";

import { CHROMIUM_PUBLIC_KEY_DER_BASE64 } from "./scripts/native-host/identity.mjs";

const ICONS = {
  16: "icons/arthur-16.png",
  32: "icons/arthur-32.png",
  48: "icons/arthur-48.png",
  128: "icons/arthur-128.png",
};
const EXTENSION_NAME = "Arthur — Article Saver";
const EXTENSION_DESCRIPTION = "Save the rendered article you are reading as clean, local Markdown.";
const HOMEPAGE_URL = "https://olhapi.github.io/arthur/";

export default defineConfig({
  vite: () => ({ plugins: [tailwindcss()] }),
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
  manifest: ({ browser, mode }) => ({
    // The fixed key keeps local Chromium builds aligned with the native host.
    // Chrome Web Store packages must omit it; the store assigns their identity.
    ...(browser === "firefox" || mode === "store" ? {} : { key: CHROMIUM_PUBLIC_KEY_DER_BASE64 }),
    name: EXTENSION_NAME,
    description: EXTENSION_DESCRIPTION,
    homepage_url: HOMEPAGE_URL,
    icons: ICONS,
    action: { default_icon: ICONS },
    permissions: ["activeTab", "storage", "nativeMessaging", "downloads"],
    host_permissions: ["http://*/*", "https://*/*"],
    browser_specific_settings: {
      gecko: {
        id: "arthur@olhapi.com",
        data_collection_permissions: {
          required: ["none"],
        },
      },
    },
  }),
});
