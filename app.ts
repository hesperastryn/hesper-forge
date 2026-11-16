// The forge's HTTP server: one process serving the GitHub-compatible
// surface — REST v3 under /api/v3, GraphQL v4 at /api/graphql, MCP at /mcp
// and git smart HTTP at /<owner>/<repo>.git/... — over the shared store.
// main.ts owns the entry <-> env lifecycle; this file is only the server.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { executeGraphQL } from './graphql.ts';
import { handleGit, isGitPath } from './githttp.ts';
import { isAuthenticated, readBody, requestUrl, sendError, sendJson } from './httputil.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';

async function handleGraphql(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!isAuthenticated(req)) {
    sendError(res, 401, 'Requires authentication');
    return;
  }
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    return;
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) =>
      typeof entry === 'object' && entry !== null ? executeGraphQL(entry as { query?: unknown }) : { data: null, errors: [{ message: 'Invalid operation' }] },
    );
    sendJson(res, 200, results);
    return;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    sendJson(res, 400, { errors: [{ message: 'A JSON object body is required' }] });
    return;
  }
  const result = executeGraphQL(parsed as { query?: unknown; variables?: unknown; operationName?: unknown });
  sendJson(res, 200, result);
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = requestUrl(req);
  const path = url.pathname;
  const method = req.method ?? 'GET';

  // The env's boot probe: no token, always 200 {"ok":true}.
  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    if (!isAuthenticated(req)) {
      sendError(res, 401, 'Requires authentication');
      return;
    }
    await handleRest(req, res, path);
    return;
  }

  if (path === '/api/graphql') {
    if (method !== 'POST') {
      sendError(res, 404, 'Not Found');
      return;
    }
    await handleGraphql(req, res);
    return;
  }

  if (path === '/mcp') {
    if (method !== 'POST') {
      sendError(res, 404, 'Not Found');
      return;
    }
    await handleMcp(req, res);
    return;
  }

  if (isGitPath(path)) {
    await handleGit(req, res, path);
    return;
  }

  sendError(res, 404, 'Not Found');
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    route(req, res).catch(() => {
      // A handler failure must never take the process down: the suite's
      // robustness checks require the server to stay up through bad input.
      if (!res.headersSent) sendError(res, 500, 'Internal Server Error');
      else res.end();
    });
  });
}
