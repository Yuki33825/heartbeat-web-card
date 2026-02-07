import { defineConfig } from "vite";

export default defineConfig({
  build: {
    rollupOptions: {
      input: ["sender.html", "index.html"],
    },
  },
});
