import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";

const envDir = import.meta.dirname;

export default defineConfig(async ({ mode }) => {
  // loadEnv runs before config is applied — process.env alone misses artifacts/client/.env
  const env = loadEnv(mode, envDir, "");

  const rawPort = env.PORT ?? process.env.PORT;
  if (!rawPort) {
    throw new Error("PORT is required. Set it in artifacts/client/.env");
  }

  const port = Number(rawPort);
  if (Number.isNaN(port) || port <= 0) {
    throw new Error(`Invalid PORT value: "${rawPort}"`);
  }

  const basePath = env.BASE_PATH ?? process.env.BASE_PATH;
  if (!basePath) {
    throw new Error("BASE_PATH is required. Set it in artifacts/client/.env");
  }

  const apiProxyTarget =
    env.API_PROXY_TARGET ??
    process.env.API_PROXY_TARGET ??
    "http://localhost:8080";

  return {
    base: basePath,
    plugins: [
      react(),
      tailwindcss(),
      runtimeErrorOverlay(),
      ...(mode !== "production" && process.env.REPL_ID !== undefined
        ? [
            await import("@replit/vite-plugin-cartographer").then((m) =>
              m.cartographer({
                root: path.resolve(envDir, ".."),
              }),
            ),
            await import("@replit/vite-plugin-dev-banner").then((m) =>
              m.devBanner(),
            ),
          ]
        : []),
    ],
    resolve: {
      alias: {
        "@": path.resolve(envDir, "src"),
        "@assets": path.resolve(envDir, "..", "..", "attached_assets"),
      },
      dedupe: ["react", "react-dom"],
    },
    root: path.resolve(envDir),
    build: {
      outDir: path.resolve(envDir, "dist/public"),
      emptyOutDir: true,
    },
    server: {
      port,
      host: "0.0.0.0",
      allowedHosts: true,
      proxy: {
        "/api": {
          target: apiProxyTarget,
          changeOrigin: true,
        },
      },
      fs: {
        strict: true,
        deny: ["**/.*"],
      },
    },
    preview: {
      port,
      host: "0.0.0.0",
      allowedHosts: true,
      proxy: {
        "/api": {
          target: apiProxyTarget,
          changeOrigin: true,
        },
      },
    },
  };
});
