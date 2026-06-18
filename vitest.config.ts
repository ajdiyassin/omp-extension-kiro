import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    server: {
      deps: {
        // @oh-my-pi packages ship raw TypeScript (`"main": "./src/index.ts"`); Vitest must
        // transform them rather than externalize. Needed because convertToolsToKiro imports
        // toolWireSchema from @oh-my-pi/pi-ai/utils/schema/wire.
        inline: [/@oh-my-pi\//],
      },
    },
  },
});
