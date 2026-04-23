import { defineConfig } from "vite";
import path from "node:path";

export default defineConfig({
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        display: path.resolve("clients/display/index.html"),
        controller: path.resolve("clients/controller/index.html")
      }
    }
  }
});
