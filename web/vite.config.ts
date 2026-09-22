import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

/** The Pulse backend (`uv run pulse-serve`). In development, Vite forwards API and WebSocket traffic to it. */
const BACKEND = process.env.PULSE_BACKEND ?? 'http://127.0.0.1:8000'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/session': BACKEND,
      '/sessions': BACKEND,
      '/health': BACKEND,
      '/ws': { target: BACKEND.replace(/^http/, 'ws'), ws: true },
    },
  },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
})
