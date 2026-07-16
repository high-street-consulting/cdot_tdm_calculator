import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
export default defineConfig({
    plugins: [react()],
    server: {
        port: 5180,
        strictPort: true,
    },
    build: {
        target: "es2022",
        sourcemap: true,
        chunkSizeWarningLimit: 2000, // @arcgis/core is large; expected
    },
    test: {
        globals: true,
        environment: "node",
        include: ["src/**/*.test.{ts,tsx}"],
    },
});
