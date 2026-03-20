#!/usr/bin/env node
/**
 * Standalone HTTP Sim Server — shared across all language workers.
 *
 * Starts a minimal HTTP server that responds to any request with {"ok":true}
 * after a configurable latency delay. All SDK language workers (TS, Python,
 * Java, C#) use this same Node.js server for HTTP handler simulation, ensuring
 * consistent behavior and eliminating the HTTP server implementation as a
 * variable in performance comparisons.
 *
 * Environment variables:
 *   HANDLER_LATENCY_MS   — response delay in ms (default: 20)
 *   HTTP_SIM_PORT_FILE   — file to write the assigned port to (required)
 *
 * The server binds to 127.0.0.1:0 (random port), writes the port number to
 * HTTP_SIM_PORT_FILE, then stays alive until killed.
 */

import * as http from 'node:http';
import * as fs from 'node:fs';

const latencyMs = parseInt(process.env.HANDLER_LATENCY_MS || '20', 10);
const portFile = process.env.HTTP_SIM_PORT_FILE || '';

if (!portFile) {
  console.error('[http-sim-server] HTTP_SIM_PORT_FILE is required');
  process.exit(1);
}

const server = http.createServer((_req, res) => {
  setTimeout(() => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  }, latencyMs);
});

server.listen(0, '127.0.0.1', () => {
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  fs.writeFileSync(portFile, String(port));
  console.log(`[http-sim-server] Listening on 127.0.0.1:${port} (latency=${latencyMs}ms)`);
});
