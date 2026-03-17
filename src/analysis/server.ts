/**
 * Analysis web server — serves the UI and proxies GCS data.
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { listRuns, loadRun, loadRunMetadata, type ProgressCallback } from './data-loader.js';

const PORT = parseInt(process.env.PORT || '4000', 10);
const PUBLIC_DIR = path.resolve(import.meta.dirname, 'public');

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function sendJson(res: http.ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(res: http.ServerResponse, status: number, message: string): void {
  sendJson(res, { error: message }, status);
}

function serveStatic(res: http.ServerResponse, urlPath: string): void {
  // Default to index.html
  let filePath = urlPath === '/' ? '/index.html' : urlPath;

  // Prevent path traversal
  const resolved = path.resolve(PUBLIC_DIR, '.' + filePath);
  if (!resolved.startsWith(PUBLIC_DIR)) {
    sendError(res, 403, 'Forbidden');
    return;
  }

  if (!fs.existsSync(resolved)) {
    sendError(res, 404, 'Not found');
    return;
  }

  const ext = path.extname(resolved);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  const content = fs.readFileSync(resolved);

  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': content.length,
  });
  res.end(content);
}

const server = http.createServer((req, res) => {
  const t0 = Date.now();
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // Log all requests
  log(`${req.method} ${pathname}${url.search}`);

  // API routes
  if (pathname === '/api/runs' && req.method === 'GET') {
    try {
      const runs = listRuns();
      log(`  → 200 (${runs.length} runs, ${Date.now() - t0}ms)`);
      sendJson(res, runs);
    } catch (e: any) {
      log(`  → 500 ERROR: ${e.message}`);
      console.error(e.stack);
      sendError(res, 500, e.message);
    }
    return;
  }

  const runMatch = pathname.match(/^\/api\/runs\/([^/]+)$/);
  if (runMatch && req.method === 'GET') {
    const runId = runMatch[1];
    const refresh = url.searchParams.get('refresh') === '1';
    const useSSE = url.searchParams.get('stream') === '1';
    log(`  Loading run ${runId} (refresh=${refresh}, stream=${useSSE})...`);

    if (useSSE) {
      // Server-Sent Events — stream progress then data
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });

      const sendEvent = (event: string, data: string) => {
        res.write(`event: ${event}\ndata: ${data}\n\n`);
      };

      const onProgress: ProgressCallback = (msg) => {
        sendEvent('progress', msg);
      };

      try {
        const data = loadRun(runId, refresh, onProgress);
        sendEvent('data', JSON.stringify(data));
        log(`  → SSE complete (${data.length} scenarios, ${Date.now() - t0}ms)`);
      } catch (e: any) {
        sendEvent('error', e.message);
        log(`  → SSE ERROR: ${e.message}`);
        console.error(e.stack);
      }
      res.end();
    } else {
      // Standard JSON response (for cached data / programmatic use)
      try {
        const data = loadRun(runId, refresh);
        log(`  → 200 (${data.length} scenarios, ${Date.now() - t0}ms)`);
        sendJson(res, data);
      } catch (e: any) {
        log(`  → 500 ERROR loading run ${runId}: ${e.message}`);
        console.error(e.stack);
        sendError(res, 500, e.message);
      }
    }
    return;
  }

  // Run metadata endpoint
  const metaMatch = pathname.match(/^\/api\/runs\/([^/]+)\/metadata$/);
  if (metaMatch && req.method === 'GET') {
    const runId = metaMatch[1];
    try {
      const meta = loadRunMetadata(runId);
      log(`  → 200 metadata for ${runId} (${meta ? 'found' : 'null'}, ${Date.now() - t0}ms)`);
      sendJson(res, meta);
    } catch (e: any) {
      log(`  → 500 ERROR loading metadata for ${runId}: ${e.message}`);
      sendError(res, 500, e.message);
    }
    return;
  }

  // Static files
  serveStatic(res, pathname);
  log(`  → static ${pathname} (${Date.now() - t0}ms)`);
});

// Increase server timeout to handle long GCS fetches
server.timeout = 600_000; // 10 minutes
server.keepAliveTimeout = 600_000;

server.listen(PORT, () => {
  log(`Analysis server running at http://localhost:${PORT}`);
  log(`Public dir: ${PUBLIC_DIR}`);
});
