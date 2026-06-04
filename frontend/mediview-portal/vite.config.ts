import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";

const authProxyTarget = process.env.AUTH_API_PROXY_TARGET?.trim() || 'http://127.0.0.1:8788';
const apiProxyTarget = process.env.API_PROXY_TARGET?.trim() || 'http://127.0.0.1:3001';
const videoProxyTarget = process.env.VIDEO_API_PROXY_TARGET?.trim() || 'http://127.0.0.1:8787';
const pacsNativeProxyTarget = process.env.PACS_NATIVE_PROXY_TARGET?.trim() || 'http://192.168.4.150';
const ohifProxyTarget = process.env.OHIF_PROXY_TARGET?.trim() || 'http://127.0.0.1:3000';

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  server: {
    host: "::",
    port: 8080,
    allowedHosts: ['pacs.octelerad.com'],
    proxy: {
      '/api': {
        target: apiProxyTarget,
        changeOrigin: true,
      },
      '/media': {
        target: apiProxyTarget,
        changeOrigin: true,
      },
      '/auth-api': {
        target: authProxyTarget,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/auth-api/, ''),
      },
      '/video-api': {
        target: videoProxyTarget,
        changeOrigin: false,
        rewrite: (path) => path.replace(/^\/video-api/, ''),
      },
      '/external-pacs': {
        target: pacsNativeProxyTarget,
        changeOrigin: true,
        ws: true,
        rewrite: (path) => path.replace(/^\/external-pacs/, ''),
      },
      '/viewer': {
        target: ohifProxyTarget,
        changeOrigin: true,
      },
      '/orthanc': {
        target: ohifProxyTarget,
        changeOrigin: true,
      },
      '/dicom-web': {
        target: ohifProxyTarget,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/dicom-web/, '/orthanc/dicom-web'),
      },
      '/wado': {
        target: ohifProxyTarget,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/wado/, '/orthanc/wado'),
      },
      '/assets': {
        target: ohifProxyTarget,
        changeOrigin: true,
      },
      '^/[A-Za-z0-9_~.-]+\\.(?:js|css|wasm|map|json|html|LICENSE)$': {
        target: ohifProxyTarget,
        changeOrigin: true,
      },
    },
    hmr: {
      overlay: false,
    },
  },
  plugins: [react(), mode === "development" && componentTagger()].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/livekit-client/')) {
            return 'vendor-livekit-client';
          }
          if (id.includes('node_modules/@livekit/protocol/')) {
            return 'vendor-livekit-protocol';
          }
          if (
            id.includes('node_modules/@livekit/components-react/') ||
            id.includes('node_modules/@livekit/components-core/')
          ) {
            return 'vendor-livekit-components';
          }
        },
      },
    },
  },
}));
