// Git plumbing in pure Node: pkt-lines, SHA-1 object identity, packfiles
// (read with ofs/ref delta resolution, write as full objects), trees,
// commits, reachability with shallow depth limits, ancestry, three-way
// merges and tree diffs. No git binary and no dependencies — node:crypto
// and node:zlib only, as the contest rules require.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { GitObject, GitObjectType, RepoRec } from './store.ts';

export const ZERO_OID = '0000000000000000000000000000000000000000';

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

export function putObject(repo: RepoRec, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

// ---------------------------------------------------------------------------
// pkt-lines

export type PktKind = 'data' | 'flush' | 'delim' | 'response-end';

export interface Pkt {
  kind: PktKind;
  payload: Buffer;
}

export function encodePkt(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  if (length > 0xffff) throw new Error(`pkt-line too long: ${length}`);
  const head = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

/** Decode every complete pkt-line in a buffer; trailing partial data is an error. */
export function decodePkts(buffer: Buffer): Pkt[] {
  const packets: Pkt[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line header');
    const head = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error(`bad pkt-line header ${JSON.stringify(head)}`);
    const length = parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 3) {
      offset += 4;
      continue;
    }
    if (offset + length > buffer.length) throw new Error('truncated pkt-line payload');
    packets.push({ kind: 'data', payload: Buffer.from(buffer.subarray(offset + 4, offset + length)) });
    offset += length;
  }
  return packets;
}

// ---------------------------------------------------------------------------
// packfiles

const TYPE_IDS: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const TYPE_NUMBERS: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

function encodePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const bytes: number[] = [];
  let first = (TYPE_NUMBERS[type] << 4) | (size & 0x0f);
  size = Math.floor(size / 16);
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size = Math.floor(size / 128);
    if (size > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/** A version-2 pack of full (non-delta) objects, with its SHA-1 trailer. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(encodePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Inflate one deflated run starting at `offset`, knowing its inflated size. */
function inflateRun(buffer: Buffer, offset: number, expectedSize: number): { data: Buffer; next: number } {
  let span = Math.min(buffer.length - offset, Math.max(64, Math.ceil(expectedSize * 1.1) + 32));
  for (;;) {
    try {
      const data = inflateSync(buffer.subarray(offset, offset + span));
      if (data.length === expectedSize) {
        // Find the exact consumed length: shrink while the prefix still inflates.
        let lo = 1;
        let hi = span;
        while (lo < hi) {
          const mid = Math.floor((lo + hi) / 2);
          let ok = false;
          try {
            ok = inflateSync(buffer.subarray(offset, offset + mid)).length === expectedSize;
          } catch {
            ok = false;
          }
          if (ok) hi = mid;
          else lo = mid + 1;
        }
        return { data, next: offset + lo };
      }
    } catch {
      // span too small (or corrupt): grow and retry below.
    }
    if (offset + span >= buffer.length) throw new Error('pack entry does not inflate');
    span = Math.min(buffer.length - offset, span * 2);
  }
}

/** Apply a git delta to a base object. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos] as number;
      pos += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (pos < delta.length) {
    const op = delta[pos] as number;
    pos += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          copyOffset |= (delta[pos] as number) << (8 * bit);
          pos += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (op & (0x10 << bit)) {
          copySize |= (delta[pos] as number) << (8 * bit);
          pos += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op !== 0) {
      out.push(delta.subarray(pos, pos + op));
      produced += op;
      pos += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize || produced !== targetSize) throw new Error('delta target size mismatch');
  return result;
}

interface PackEntry {
  offset: number;
  type: GitObjectType | 'ofs-delta' | 'ref-delta';
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
}

/**
 * Read a pack into `into` (existing objects there serve as thin-pack bases).
 * Returns the number of objects the pack declared. Throws on any structural
 * problem or a bad trailer checksum.
 */
export function readPack(pack: Buffer, into: Map<string, GitObject>): number {
  if (pack.length < 12 + 20) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack magic missing');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const digest = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!digest.equals(trailer)) throw new Error('pack checksum mismatch');

  const entries: PackEntry[] = [];
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const start = offset;
    let byte = pack[offset] as number;
    offset += 1;
    const typeId = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset] as number;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    if (typeId === 6) {
      // ofs-delta: base offset encoded as a negative displacement.
      byte = pack[offset] as number;
      offset += 1;
      let displacement = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[offset] as number;
        offset += 1;
        displacement = ((displacement + 1) << 7) | (byte & 0x7f);
      }
      const inflated = inflateRun(pack, offset, size);
      entries.push({ offset: start, type: 'ofs-delta', data: inflated.data, baseOffset: start - displacement });
      offset = inflated.next;
    } else if (typeId === 7) {
      const baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const inflated = inflateRun(pack, offset, size);
      entries.push({ offset: start, type: 'ref-delta', data: inflated.data, baseOid });
      offset = inflated.next;
    } else {
      const type = TYPE_IDS[typeId];
      if (type === undefined) throw new Error(`pack object type ${typeId}`);
      const inflated = inflateRun(pack, offset, size);
      entries.push({ offset: start, type, data: inflated.data });
      offset = inflated.next;
    }
  }

  const byOffset = new Map<number, PackEntry>();
  for (const entry of entries) byOffset.set(entry.offset, entry);
  const resolved = new Map<number, { oid: string; type: GitObjectType; data: Buffer }>();
  const resolve = (entry: PackEntry): { oid: string; type: GitObjectType; data: Buffer } => {
    const memo = resolved.get(entry.offset);
    if (memo !== undefined) return memo;
    let result: { oid: string; type: GitObjectType; data: Buffer };
    if (entry.type === 'ofs-delta') {
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (baseEntry === undefined) throw new Error('ofs-delta base not in pack');
      const base = resolve(baseEntry);
      const data = applyDelta(base.data, entry.data);
      result = { oid: hashObject(base.type, data), type: base.type, data };
    } else if (entry.type === 'ref-delta') {
      let base = into.get(entry.baseOid as string);
      if (base === undefined) {
        const baseEntry = entries.find((candidate) => candidate.type !== 'ofs-delta' && candidate.type !== 'ref-delta' && hashObject(candidate.type, candidate.data) === entry.baseOid);
        if (baseEntry === undefined) throw new Error('ref-delta base not found');
        base = resolve(baseEntry);
      }
      const data = applyDelta(base.data, entry.data);
      result = { oid: hashObject(base.type, data), type: base.type, data };
    } else {
      result = { oid: hashObject(entry.type, entry.data), type: entry.type, data: entry.data };
    }
    resolved.set(entry.offset, result);
    return result;
  };
  for (const entry of entries) {
    const object = resolve(entry);
    if (!into.has(object.oid)) into.set(object.oid, { type: object.type, data: object.data });
  }
  return count;
}

// ---------------------------------------------------------------------------
// trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    const mode = data.subarray(pos, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    pos = nul + 21;
  }
  return entries;
}

export function isDirMode(mode: string): boolean {
  return parseInt(mode, 8) === 0o40000;
}

/** Git's tree order: by name, directories as if the name ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return isDirMode(entry.mode) ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Every file under a tree, as path -> {oid, mode}. */
export function flattenTree(repo: RepoRec, treeOid: string, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
  const tree = repo.objects.get(treeOid);
  if (tree === undefined || tree.type !== 'tree') return out;
  for (const entry of parseTree(tree.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (isDirMode(entry.mode)) flattenTree(repo, entry.oid, path, out);
    else out.set(path, { oid: entry.oid, mode: entry.mode });
  }
  return out;
}

/** Build (and store) the tree hierarchy for a flat path map; returns the root tree oid. */
export function buildTreeFromFlat(repo: RepoRec, flat: ReadonlyMap<string, { oid: string; mode: string }>): string {
  interface Node {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, value] of flat) {
    const segments = path.split('/');
    let node = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const name = segments[index] as string;
      if (!node.dirs.has(name)) node.dirs.set(name, { files: new Map(), dirs: new Map() });
      node = node.dirs.get(name) as Node;
    }
    node.files.set(segments[segments.length - 1] as string, value);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, value] of node.files) entries.push({ mode: value.mode, name, oid: value.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return putObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

/** The tree oid of a commit, or null. */
export function commitTree(repo: RepoRec, commitOid: string): string | null {
  const commit = repo.objects.get(commitOid);
  if (commit === undefined || commit.type !== 'commit') return null;
  return parseCommit(commit.data).tree;
}

// ---------------------------------------------------------------------------
// commits

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommitData(fields: { tree: string; parents: readonly string[]; author: string; committer: string; message: string }): Buffer {
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author}`);
  lines.push(`committer ${fields.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${fields.message}`, 'utf8');
}

/** Follow tag objects to the commit they name (or return the oid itself). */
export function peelToCommit(repo: RepoRec, oid: string): string {
  let current = oid;
  for (let guard = 0; guard < 16; guard += 1) {
    const object = repo.objects.get(current);
    if (object === undefined) return current;
    if (object.type === 'commit') return current;
    if (object.type !== 'tag') return current;
    const match = /^object ([0-9a-f]{40})/m.exec(object.data.toString('utf8'));
    if (match === null) return current;
    current = match[1] as string;
  }
  return current;
}

/** The commit a ref names after peeling, or null when the ref is absent. */
export function refCommit(repo: RepoRec, ref: string): string | null {
  const oid = repo.refs.get(ref);
  if (oid === undefined) return null;
  const commit = peelToCommit(repo, oid);
  return repo.objects.get(commit)?.type === 'commit' ? commit : null;
}

/** Ancestor set of a commit (itself included), optionally with some commits treated as parentless. */
export function ancestorSet(repo: RepoRec, tip: string, parentless?: ReadonlySet<string>): Set<string> {
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    seen.add(oid);
    if (parentless !== undefined && parentless.has(oid)) continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return seen;
}

export function isAncestor(repo: RepoRec, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  return ancestorSet(repo, descendant).has(ancestor);
}

/** A common ancestor of two commits (the merge base), or null. */
export function mergeBase(repo: RepoRec, a: string, b: string): string | null {
  const ancestorsOfA = ancestorSet(repo, a);
  const seen = new Set<string>();
  const queue = [b];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestorsOfA.has(oid)) return oid;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return null;
}

/** Commits from a tip, newest first (breadth by generation), for history listings. */
export function walkHistory(repo: RepoRec, tip: string): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    seen.add(oid);
    order.push(oid);
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return order;
}

// ---------------------------------------------------------------------------
// upload-pack object selection

export interface FetchSelection {
  /** The objects to pack. */
  objects: GitObject[];
  /** Commits whose parents were cut by the depth limit (the shallow boundary). */
  boundary: string[];
  /** Client boundary commits whose parents are included now (no longer shallow). */
  unshallow: string[];
}

/** The full object closure (commits, trees, blobs, tags) of a set of tips. */
export function objectClosure(repo: RepoRec, tips: readonly string[], parentless?: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (out.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    out.add(oid);
    if (object.type === 'commit') {
      const view = parseCommit(object.data);
      stack.push(view.tree);
      if (parentless === undefined || !parentless.has(oid)) for (const parent of view.parents) stack.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      const match = /^object ([0-9a-f]{40})/m.exec(object.data.toString('utf8'));
      if (match !== null) stack.push(match[1] as string);
    }
  }
  return out;
}

/**
 * Select the pack for a fetch: everything reachable from the wants (cut at
 * `depth` generations of commits when a depth is given) minus everything
 * reachable from the haves (client-shallow commits count as parentless).
 */
export function selectFetchObjects(
  repo: RepoRec,
  wants: readonly string[],
  haves: readonly string[],
  depth: number | null,
  clientShallow: readonly string[],
): FetchSelection {
  const parentless = new Set(clientShallow);
  const haveObjects = objectClosure(repo, haves.map((oid) => peelToCommit(repo, oid)), parentless);

  // Breadth-first by generation from the want commits, honouring the depth.
  const wantCommits = new Set<string>();
  const boundary = new Set<string>();
  const limit = depth === null ? Number.POSITIVE_INFINITY : depth;
  let frontier = wants.map((oid) => peelToCommit(repo, oid)).filter((oid) => repo.objects.get(oid)?.type === 'commit');
  let generation = 0;
  const queued = new Set(frontier);
  while (frontier.length > 0) {
    generation += 1;
    const next: string[] = [];
    for (const oid of frontier) {
      wantCommits.add(oid);
      const view = parseCommit((repo.objects.get(oid) as GitObject).data);
      if (generation >= limit) {
        if (view.parents.length > 0) boundary.add(oid);
        continue;
      }
      for (const parent of view.parents) {
        if (!queued.has(parent) && repo.objects.get(parent)?.type === 'commit') {
          queued.add(parent);
          next.push(parent);
        }
      }
    }
    frontier = next;
  }

  // The pack: every included commit, the full tree closure of each, and any
  // tag objects on the path from a wanted ref to an included commit.
  const precise = new Set<string>();
  for (const oid of wantCommits) {
    precise.add(oid);
    const tree = parseCommit((repo.objects.get(oid) as GitObject).data).tree;
    for (const entry of objectClosure(repo, [tree])) precise.add(entry);
  }
  for (const oid of wants) {
    let current = oid;
    for (let guard = 0; guard < 16; guard += 1) {
      const object = repo.objects.get(current);
      if (object === undefined || object.type !== 'tag') break;
      precise.add(current);
      const match = /^object ([0-9a-f]{40})/m.exec(object.data.toString('utf8'));
      if (match === null) break;
      current = match[1] as string;
    }
  }

  const objects: GitObject[] = [];
  for (const oid of precise) {
    if (haveObjects.has(oid)) continue;
    objects.push(repo.objects.get(oid) as GitObject);
  }
  const unshallow: string[] = [];
  for (const oid of clientShallow) {
    if (wantCommits.has(oid) && !boundary.has(oid)) unshallow.push(oid);
  }
  return { objects, boundary: [...boundary].filter((oid) => !haveObjects.has(oid)), unshallow };
}

// ---------------------------------------------------------------------------
// merges and diffs

export interface MergeOutcome {
  treeOid: string | null;
  conflicts: string[];
}

/** Three-way merge of flattened trees; a null treeOid means conflicts (listed). */
export function mergeTrees(repo: RepoRec, baseTree: string | null, ourTree: string | null, theirTree: string | null): MergeOutcome {
  const base = baseTree === null ? new Map<string, { oid: string; mode: string }>() : flattenTree(repo, baseTree);
  const ours = ourTree === null ? new Map<string, { oid: string; mode: string }>() : flattenTree(repo, ourTree);
  const theirs = theirTree === null ? new Map<string, { oid: string; mode: string }>() : flattenTree(repo, theirTree);
  const paths = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  const result = new Map<string, { oid: string; mode: string }>();
  const conflicts: string[] = [];
  const same = (a?: { oid: string; mode: string }, b?: { oid: string; mode: string }): boolean =>
    (a === undefined && b === undefined) || (a !== undefined && b !== undefined && a.oid === b.oid && a.mode === b.mode);
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    if (same(o, t)) {
      if (o !== undefined) result.set(path, o);
    } else if (same(b, o)) {
      if (t !== undefined) result.set(path, t);
    } else if (same(b, t)) {
      if (o !== undefined) result.set(path, o);
    } else {
      conflicts.push(path);
    }
  }
  if (conflicts.length > 0) return { treeOid: null, conflicts };
  return { treeOid: buildTreeFromFlat(repo, result), conflicts: [] };
}

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
}

function linesOf(data: Buffer): string[] {
  const text = data.toString('utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Line-level change counts between two blobs (longest-common-subsequence based). */
export function countLineChanges(oldData: Buffer | null, newData: Buffer | null): { additions: number; deletions: number } {
  if (oldData === null && newData === null) return { additions: 0, deletions: 0 };
  if (oldData === null) return { additions: linesOf(newData as Buffer).length, deletions: 0 };
  if (newData === null) return { additions: 0, deletions: linesOf(oldData).length };
  const a = linesOf(oldData);
  const b = linesOf(newData);
  // LCS length via dynamic programming over the shorter axis.
  const width = b.length + 1;
  let prev = new Uint32Array(width);
  let curr = new Uint32Array(width);
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      curr[j] = a[i - 1] === b[j - 1] ? (prev[j - 1] as number) + 1 : Math.max(prev[j] as number, curr[j - 1] as number);
    }
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  const lcs = prev[b.length] as number;
  return { additions: b.length - lcs, deletions: a.length - lcs };
}

/** The changed files between two trees (either may be null for an empty tree). */
export function diffTrees(repo: RepoRec, fromTree: string | null, toTree: string | null): FileChange[] {
  const from = fromTree === null ? new Map<string, { oid: string; mode: string }>() : flattenTree(repo, fromTree);
  const to = toTree === null ? new Map<string, { oid: string; mode: string }>() : flattenTree(repo, toTree);
  const paths = [...new Set([...from.keys(), ...to.keys()])].sort();
  const changes: FileChange[] = [];
  for (const path of paths) {
    const before = from.get(path);
    const after = to.get(path);
    if (before !== undefined && after !== undefined && before.oid === after.oid) continue;
    const oldData = before === undefined ? null : (repo.objects.get(before.oid)?.data ?? null);
    const newData = after === undefined ? null : (repo.objects.get(after.oid)?.data ?? null);
    const counts = countLineChanges(oldData, newData);
    changes.push({
      path,
      status: before === undefined ? 'added' : after === undefined ? 'removed' : 'modified',
      additions: counts.additions,
      deletions: counts.deletions,
    });
  }
  return changes;
}
