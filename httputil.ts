// Shared HTTP plumbing for the forge's surfaces: body reading with a size
// cap, JSON replies (always with the request-id header the protocol checks
// require), and buffer replies for the git wire.

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** Read a whole request body; rejects past the cap so a bad client cannot OOM the forge. */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** A fresh non-empty request id for the X-GitHub-Request-Id header. */
export function newRequestId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase();
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = body === undefined ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': newRequestId(),
    ...headers,
  });
  res.end(text);
}

export function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': newRequestId(),
  });
  res.end(body);
}

/** GitHub's error body shape: a JSON object with a string message. */
export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

/** The request's URL parsed against a dummy origin (never throws). */
export function requestUrl(req: IncomingMessage): URL {
  try {
    return new URL(req.url ?? '/', 'http://entry');
  } catch {
    return new URL('/', 'http://entry');
  }
}

/** The bearer token of a request, or null when no usable Authorization header is present. */
export function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (match === null) return null;
  const token = (match[1] as string).trim();
  return token === '' ? null : token;
}

/**
 * Whether a request is authenticated: a bearer token must be present, and
 * when the trial token is in the environment it must match it exactly.
 */
export function isAuthenticated(req: IncomingMessage): boolean {
  const token = bearerToken(req);
  if (token === null) return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN;
  if (expected !== undefined && expected !== '') return token === expected;
  return true;
}
