const { defineConfig } = require("vite");
const react = require("@vitejs/plugin-react");
const path = require("path");

module.exports = defineConfig({
  base: "./",
  root: path.join(__dirname, "src", "renderer"),
  plugins: [react()],
  build: {
    outDir: path.join(__dirname, "dist"),
    emptyOutDir: true
  },
  server: {
    port: 5173,
    strictPort: true
  }
});
