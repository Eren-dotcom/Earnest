// Vercel serverless entry: re-export the Earnest HTTP server as the handler.
// EARNEST_RUNTIME must point at /tmp (set in vercel.json) — it is the only
// writable location in the serverless environment. State is per-instance
// and resets on cold start; the dashboard's Reset restores a clean demo.
export { default } from '../server/index.mjs';
