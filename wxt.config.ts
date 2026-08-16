import { defineConfig } from "wxt";

export default defineConfig({
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
