// Git smart HTTP: ref advertisement (protocol v0 and v2), upload-pack
// (v2 ls-refs and fetch, plus the v0 fetch fallback) and receive-pack
// (v0, report-status over side-band-64k). Repositories are addressed as
// /<owner>/<repo>.git/... and must exist already — a push cannot invent
// one; a missing repository is a 404 on every route here.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  PKT_FLUSH,
  ZERO_OID,
  decodePkts,
  encodePkt,
  isAncestor,
  peelToCommit,
  readPack,
  refCommit,
  selectFetchObjects,
  writePack,
  type Pkt,
} from './gitcore.ts';
import { readBody, requestUrl, sendBuffer, sendError } from './httputil.ts';
import { store, type RepoRec } from './store.ts';

const AGENT = 'forge/1.0.0';

function headRef(repo: RepoRec): string {
  return `refs/heads/${repo.defaultBranch}`;
}

/** The commit HEAD names (the default branch tip), or null when unborn. */
function headCommit(repo: RepoRec): string | null {
  return refCommit(repo, headRef(repo));
}

/** Sorted ref names, with HEAD handled separately by the callers. */
function sortedRefs(repo: RepoRec): string[] {
  return [...repo.refs.keys()].sort();
}

/** The commit a tag ref peels to, when the ref names a tag object. */
function peeledOf(repo: RepoRec, oid: string): string | null {
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'tag') return null;
  const commit = peelToCommit(repo, oid);
  return repo.objects.get(commit)?.type === 'commit' ? commit : null;
}

// ---------------------------------------------------------------------------
// advertisement

function v2Advertisement(res: ServerResponse, service: string): void {
  const lines = ['version 2', `agent=${AGENT}`];
  if (service === 'git-upload-pack') {
    lines.push('ls-refs=unborn', 'fetch=shallow', 'object-format=sha1');
  }
  const parts = lines.map((line) => encodePkt(`${line}\n`));
  parts.push(PKT_FLUSH);
  sendBuffer(res, 200, Buffer.concat(parts), `application/x-${service}-advertisement`);
}

function v0Advertisement(res: ServerResponse, repo: RepoRec, service: string): void {
  const isUpload = service === 'git-upload-pack';
  const caps = isUpload
    ? `multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not agent=${AGENT} symref=HEAD:${headRef(repo)}`
    : `report-status report-status-v2 delete-refs side-band-64k ofs-delta agent=${AGENT}`;
  const parts: Buffer[] = [encodePkt(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(encodePkt(`${ZERO_OID} capabilities^{}\0${caps}`));
  } else {
    let first = true;
    const head = headCommit(repo);
    const headLine = `${head ?? ZERO_OID} HEAD`;
    parts.push(encodePkt(first ? `${headLine}\0${caps}` : headLine));
    first = false;
    for (const ref of refs) {
      const oid = repo.refs.get(ref) as string;
      parts.push(encodePkt(`${oid} ${ref}`));
      const peeled = peeledOf(repo, oid);
      if (peeled !== null) parts.push(encodePkt(`${peeled} ${ref}^{}`));
    }
  }
  parts.push(PKT_FLUSH);
  sendBuffer(res, 200, Buffer.concat(parts), `application/x-${service}-advertisement`);
}

function infoRefs(req: IncomingMessage, res: ServerResponse, repo: RepoRec): void {
  const url = requestUrl(req);
  const service = url.searchParams.get('service') ?? '';
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    sendError(res, 403, 'Unsupported service');
    return;
  }
  const protocol = req.headers['git-protocol'];
  const wantsV2 = typeof protocol === 'string' && protocol.includes('version=2');
  if (service === 'git-upload-pack' && wantsV2) {
    v2Advertisement(res, service);
    return;
  }
  v0Advertisement(res, repo, service);
}

// ---------------------------------------------------------------------------
// upload-pack v2 commands

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function lsRefsResponse(repo: RepoRec, args: LsRefsArgs): Buffer {
  const parts: Buffer[] = [];
  const included = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const head = headCommit(repo);
  if (included('HEAD')) {
    if (head !== null) {
      const suffix = args.symrefs ? ` symref-target:${headRef(repo)}` : '';
      parts.push(encodePkt(`${head} HEAD${suffix}\n`));
    } else if (args.unborn) {
      const suffix = args.symrefs ? ` symref-target:${headRef(repo)}` : '';
      parts.push(encodePkt(`unborn HEAD${suffix}\n`));
    }
  }
  for (const ref of sortedRefs(repo)) {
    if (!included(ref)) continue;
    const oid = repo.refs.get(ref) as string;
    let line = `${oid} ${ref}`;
    if (args.peel) {
      const peeled = peeledOf(repo, oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    parts.push(encodePkt(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  done: boolean;
}

function sidebandChunks(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 65500;
  if (pack.length === 0) {
    parts.push(encodePkt(Buffer.concat([Buffer.from([1]), Buffer.alloc(0)])));
    return parts;
  }
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    parts.push(encodePkt(Buffer.concat([Buffer.from([1]), pack.subarray(offset, offset + CHUNK)])));
  }
  return parts;
}

function fetchResponseV2(repo: RepoRec, args: FetchArgs): Buffer {
  const parts: Buffer[] = [];
  const selection = selectFetchObjects(repo, args.wants, args.haves, args.depth, args.shallow);
  // acknowledgments
  parts.push(encodePkt('acknowledgments\n'));
  const acks = args.haves.filter((oid) => repo.objects.get(oid)?.type === 'commit');
  if (acks.length === 0) {
    parts.push(encodePkt('NAK\n'));
  } else {
    for (const oid of acks) parts.push(encodePkt(`ACK ${oid}\n`));
  }
  parts.push(Buffer.from('0001', 'ascii'));
  // shallow-info
  if (args.depth !== null || args.shallow.length > 0 || selection.unshallow.length > 0) {
    if (selection.boundary.length > 0 || selection.unshallow.length > 0) {
      parts.push(encodePkt('shallow-info\n'));
      for (const oid of selection.boundary) parts.push(encodePkt(`shallow ${oid}\n`));
      for (const oid of selection.unshallow) parts.push(encodePkt(`unshallow ${oid}\n`));
      parts.push(Buffer.from('0001', 'ascii'));
    }
  }
  // packfile
  const pack = writePack(selection.objects);
  parts.push(encodePkt('packfile\n'));
  parts.push(...sidebandChunks(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function fetchResponseV0(repo: RepoRec, args: FetchArgs): Buffer {
  const parts: Buffer[] = [];
  const selection = selectFetchObjects(repo, args.wants, args.haves, args.depth, args.shallow);
  for (const oid of selection.boundary) parts.push(encodePkt(`shallow ${oid}\n`));
  for (const oid of selection.unshallow) parts.push(encodePkt(`unshallow ${oid}\n`));
  parts.push(encodePkt('NAK\n'));
  const pack = writePack(selection.objects);
  parts.push(...sidebandChunks(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

async function uploadPack(req: IncomingMessage, res: ServerResponse, repo: RepoRec): Promise<void> {
  const body = await readBody(req);
  const protocol = req.headers['git-protocol'];
  const isV2 = typeof protocol === 'string' && protocol.includes('version=2');
  let packets: Pkt[];
  try {
    packets = decodePkts(body);
  } catch {
    sendError(res, 400, 'Malformed pkt-line stream');
    return;
  }
  if (isV2) {
    const lines: string[] = [];
    for (const packet of packets) {
      if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
    }
    const command = lines.find((line) => line.startsWith('command='));
    if (command === 'command=ls-refs') {
      const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
      for (const line of lines) {
        if (line === 'peel') args.peel = true;
        else if (line === 'symrefs') args.symrefs = true;
        else if (line === 'unborn') args.unborn = true;
        else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
      }
      sendBuffer(res, 200, lsRefsResponse(repo, args), 'application/x-git-upload-pack-result');
      return;
    }
    if (command === 'command=fetch') {
      const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, done: false };
      for (const line of lines) {
        if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
        else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
        else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
        else if (line.startsWith('deepen ')) args.depth = Number(line.slice(7).trim());
        else if (line === 'done') args.done = true;
      }
      sendBuffer(res, 200, fetchResponseV2(repo, args), 'application/x-git-upload-pack-result');
      return;
    }
    sendError(res, 400, 'Unknown command');
    return;
  }
  // v0: wants section, flush, haves section, flush.
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, done: false };
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    const space = line.indexOf(' ');
    const verb = space === -1 ? line : line.slice(0, space);
    const rest = space === -1 ? '' : line.slice(space + 1);
    if (verb === 'want') args.wants.push(rest.split(' ')[0] as string);
    else if (verb === 'have') args.haves.push(rest.trim());
    else if (verb === 'shallow') args.shallow.push(rest.trim());
    else if (verb === 'deepen') args.depth = Number(rest.trim());
    else if (line === 'done') args.done = true;
  }
  sendBuffer(res, 200, fetchResponseV0(repo, args), 'application/x-git-upload-pack-result');
}

// ---------------------------------------------------------------------------
// receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

async function receivePack(req: IncomingMessage, res: ServerResponse, repo: RepoRec): Promise<void> {
  const body = await readBody(req);
  // Split the pkt-line command list from the pack that follows it.
  let offset = 0;
  const commands: PushCommand[] = [];
  let capabilities = '';
  let malformed = false;
  for (;;) {
    if (offset + 4 > body.length) {
      malformed = commands.length === 0;
      break;
    }
    const head = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) {
      malformed = true;
      break;
    }
    const length = parseInt(head, 16);
    if (length === 0) {
      offset += 4;
      break;
    }
    if (offset + length > body.length) {
      malformed = true;
      break;
    }
    let line = body.subarray(offset + 4, offset + length).toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      capabilities = line.slice(nul + 1);
      line = line.slice(0, nul);
    }
    const parts = line.split(' ');
    if (parts.length >= 3) {
      commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts.slice(2).join(' ') });
    }
    offset += length;
  }
  const packBytes = body.subarray(offset);
  const caps = new Set(capabilities.split(' ').filter(Boolean));
  const wantsReport = caps.has('report-status') || caps.has('report-status-v2');
  const useSideband = caps.has('side-band-64k');

  let unpackLine = 'unpack ok';
  if (!malformed && packBytes.length > 0) {
    try {
      readPack(Buffer.from(packBytes), repo.objects);
    } catch (err) {
      unpackLine = `unpack ${err instanceof Error ? err.message : 'error'}`;
    }
  } else if (malformed) {
    unpackLine = 'unpack malformed command list';
  }

  const reportLines: string[] = [unpackLine];
  if (unpackLine === 'unpack ok' && !malformed) {
    for (const command of commands) {
      reportLines.push(applyPushCommand(repo, command));
    }
  } else {
    for (const command of commands) reportLines.push(`ng ${command.ref} unpack failed`);
  }

  if (!wantsReport) {
    sendBuffer(res, 200, Buffer.alloc(0), 'application/x-git-receive-pack-result');
    return;
  }
  const reportPkts = reportLines.map((line) => encodePkt(`${line}\n`));
  reportPkts.push(PKT_FLUSH);
  const reportStream = Buffer.concat(reportPkts);
  if (useSideband) {
    const parts: Buffer[] = [];
    // The whole report stream rides in band 1, chunked to pkt-line size.
    const CHUNK = 65500;
    for (let at = 0; at < reportStream.length; at += CHUNK) {
      parts.push(encodePkt(Buffer.concat([Buffer.from([1]), reportStream.subarray(at, at + CHUNK)])));
    }
    parts.push(PKT_FLUSH);
    sendBuffer(res, 200, Buffer.concat(parts), 'application/x-git-receive-pack-result');
    return;
  }
  sendBuffer(res, 200, reportStream, 'application/x-git-receive-pack-result');
}

/** Apply one ref update; returns its report-status line. */
function applyPushCommand(repo: RepoRec, command: PushCommand): string {
  const { oldOid, newOid, ref } = command;
  const current = repo.refs.get(ref);
  if (newOid === ZERO_OID) {
    if (current === undefined) return `ng ${ref} reference not found`;
    repo.refs.delete(ref);
    return `ok ${ref}`;
  }
  const target = repo.objects.get(newOid);
  if (target === undefined) return `ng ${ref} missing object`;
  if (oldOid === ZERO_OID) {
    if (current !== undefined) return `ng ${ref} reference already exists`;
  } else if (current !== undefined && current !== oldOid) {
    return `ng ${ref} stale info`;
  }
  if (ref.startsWith('refs/heads/')) {
    const commit = peelToCommit(repo, newOid);
    if (repo.objects.get(commit)?.type !== 'commit') return `ng ${ref} not a commit`;
    if (current !== undefined) {
      const currentCommit = peelToCommit(repo, current);
      if (currentCommit !== commit && !isAncestor(repo, currentCommit, commit)) {
        return `ng ${ref} non-fast-forward`;
      }
    }
  }
  repo.refs.set(ref, newOid);
  return `ok ${ref}`;
}

// ---------------------------------------------------------------------------
// routing

/** Handle one git smart-HTTP route; returns false when the path is not one. */
export function isGitPath(path: string): boolean {
  return /^\/[^/]+\/[^/]+\.git(\/|$)/.test(path);
}

export async function handleGit(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
  const match = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
  if (match === null) return false;
  const owner = decodeURIComponent(match[1] as string);
  const name = decodeURIComponent(match[2] as string);
  const rest = match[3] ?? '';
  const repo = store.getRepo(owner, name);
  if (repo === undefined) {
    sendError(res, 404, 'Not Found');
    return true;
  }
  const method = req.method ?? 'GET';
  if (method === 'GET' && rest === '/info/refs') {
    infoRefs(req, res, repo);
    return true;
  }
  if (method === 'POST' && rest === '/git-upload-pack') {
    await uploadPack(req, res, repo);
    return true;
  }
  if (method === 'POST' && rest === '/git-receive-pack') {
    await receivePack(req, res, repo);
    return true;
  }
  sendError(res, 404, 'Not Found');
  return true;
}
