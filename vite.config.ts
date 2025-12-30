import { reactRouter } from "@react-router/dev/vite";
import { defineConfig, type UserConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

// Parse SHOPIFY_APP_URL to extract hostname and protocol
// server.host MUST be a hostname (127.0.0.1), NEVER a full URL
// server.origin can be the full URL for CORS/redirects
const appUrl = process.env.APP_URL || process.env.SHOPIFY_APP_URL || "http://localhost:3000";
const parsed = new URL(appUrl);
const hostname = parsed.hostname; // Extract hostname for HMR/allowedHosts

// Log for debugging (no secrets)
console.log("[vite.config] SHOPIFY_APP_URL:", appUrl);
console.log("[vite.config] Parsed hostname:", hostname);

// Determine HMR protocol (ws for http, wss for https)
const hmrProtocol = parsed.protocol.replace(":", ""); // "http" -> "ws", "https" -> "wss"
const isSecure = parsed.protocol === "https:";

let hmrConfig;
if (hostname === "localhost" || hostname === "127.0.0.1") {
  hmrConfig = {
    protocol: "ws",
    host: "localhost",
    port: 64999,
    clientPort: 64999,
  };
} else {
  // For Cloudflare tunnels, use extracted hostname (not full URL)
  hmrConfig = {
    protocol: isSecure ? "wss" : "ws",
    host: hostname, // Use extracted hostname only, never full URL
    port: parseInt(process.env.FRONTEND_PORT!) || 8002,
    clientPort: isSecure ? 443 : 64999,
  };
}

export default defineConfig({
  server: {
    host: "127.0.0.1", // ALWAYS a hostname, NEVER a URL
    origin: appUrl, // Full URL for CORS/redirects
    allowedHosts: [hostname], // Use hostname only, never full URL
    cors: {
      preflightContinue: true,
    },
    port: Number(process.env.PORT || 3000),
    hmr: hmrConfig,
    fs: {
      // See https://vitejs.dev/config/server-options.html#server-fs-allow for more information
      allow: ["app", "node_modules"],
    },
  },
  plugins: [
    reactRouter(),
    tsconfigPaths(),
  ],
  build: {
    assetsInlineLimit: 0,
  },
  optimizeDeps: {
    include: ["@shopify/app-bridge-react"],
  },
}) satisfies UserConfig;
