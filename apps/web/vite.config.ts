// Builds the browser assets into dist/, which the Worker serves as static
// assets. Every emitted file name carries a content hash, so public/_headers
// can mark /assets/* immutable; the Worker reads the hashed names from the
// manifest (src/ui/assets.ts).
import solidPlugin from "@solidjs/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({
  // Only the browser's components are Solid; src/ renders Hono JSX on the
  // server.
  plugins: [solidPlugin({ include: ["client/**/*.tsx"] })],
  publicDir: "public",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    manifest: true,
    target: "es2022",
    // A font stays a file: inlined, it would be fetched again with every
    // stylesheet that names it.
    assetsInlineLimit: (file) => !file.endsWith(".woff2"),
    rollupOptions: {
      input: [
        "client/site.js",
        "client/room/main.tsx",
        "client/solo.js",
        "client/match.js",
        "client/screen.js",
        "client/styles/common.css",
        "client/styles/site.css",
        "client/styles/admin.css",
        "client/styles/game.css",
        "client/styles/room.css",
        "client/styles/screen.css",
      ],
    },
  },
});
