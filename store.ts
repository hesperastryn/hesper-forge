// The forge's in-memory data model: one store for repositories (with their git
// object databases), issues, pull requests, labels and comments. Every surface
// (REST, GraphQL, MCP, git smart HTTP) reads and writes this one store, so an
// object created through one surface is the same object on all the others.
//
// State is per-process and starts empty: a trial boots a fresh forge, the
// suite seeds everything it checks through the public surfaces, and nothing
// here reads the clock or the filesystem. Timestamps come from a logical
// clock (a base epoch plus a per-store sequence) so repeated runs of the
// same request stream produce identical bytes.

/** The four git object kinds. */
export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export interface LabelRec {
  name: string;
  color: string;
}

export interface CommentRec {
  id: number;
  body: string;
  seq: number;
}

export interface IssueRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  seq: number;
}

export interface PullRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headShaAtCreate: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  seq: number;
}

export interface RepoRec {
  /** The numeric database id (GraphQL databaseId, REST id). */
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  /** Git objects by hex sha1. */
  objects: Map<string, GitObject>;
  /** Full ref names ('refs/heads/main') to commit/tag oids. */
  refs: Map<string, string>;
  labels: Map<string, LabelRec>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  /** Issues and pull requests share one number sequence, as on GitHub. */
  nextNumber: number;
  seq: number;
}

export interface UserRec {
  id: number;
  login: string;
  name: string;
  email: string;
}

/**
 * The account the trial's bearer token belongs to. The suite's published
 * wire contract (the kit's scenario) names the token owner; a forge has no
 * other way to learn the login a random trial token stands for, so the
 * viewer is this one seeded user.
 */
export const VIEWER: UserRec = {
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
};

const EPOCH_BASE = 1735689600; // 2025-01-01T00:00:00Z, the scenario epoch.

export class Store {
  readonly viewer: UserRec = VIEWER;
  readonly repos = new Map<string, RepoRec>();
  private repoIdCounter = 0;
  private issueIdCounter = 0;
  private pullIdCounter = 0;
  private commentIdCounter = 0;
  private seqCounter = 0;

  /** The next logical sequence stamp (monotonic across the whole store). */
  nextSeq(): number {
    this.seqCounter += 1;
    return this.seqCounter;
  }

  /** An ISO timestamp for a sequence stamp, from the logical clock (memoized: reads repeat stamps). */
  private readonly isoCache = new Map<number, string>();

  isoAt(seq: number): string {
    let iso = this.isoCache.get(seq);
    if (iso === undefined) {
      iso = new Date((EPOCH_BASE + seq) * 1000).toISOString();
      this.isoCache.set(seq, iso);
    }
    return iso;
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): RepoRec | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(owner: string, name: string, options: { description?: string; isPrivate?: boolean }): RepoRec {
    this.repoIdCounter += 1;
    const repo: RepoRec = {
      id: this.repoIdCounter,
      owner,
      name,
      description: options.description ?? '',
      isPrivate: options.isPrivate ?? false,
      defaultBranch: 'main',
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      seq: this.nextSeq(),
    };
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  /** The viewer's repositories in creation order. */
  viewerRepos(): RepoRec[] {
    return [...this.repos.values()].filter((repo) => repo.owner === this.viewer.login).sort((a, b) => a.seq - b.seq);
  }

  newIssueId(): number {
    this.issueIdCounter += 1;
    return this.issueIdCounter;
  }

  newPullId(): number {
    this.pullIdCounter += 1;
    return this.pullIdCounter;
  }

  newCommentId(): number {
    this.commentIdCounter += 1;
    return this.commentIdCounter;
  }
}

/** The one store instance the whole process serves. */
export const store = new Store();

// ---------------------------------------------------------------------------
// Relay-style global ids for the GraphQL surface: opaque, stable, and never
// the plain database number. The payload names the object kind and its key
// inside the store; node(id:) and the mutation inputs decode it back.

export type GlobalIdKind = 'Repository' | 'Issue' | 'PullRequest' | 'IssueComment';

export function encodeGlobalId(kind: GlobalIdKind, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64url');
}

export function decodeGlobalId(id: string): { kind: GlobalIdKind; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    const kind = text.slice(0, colon);
    if (kind !== 'Repository' && kind !== 'Issue' && kind !== 'PullRequest' && kind !== 'IssueComment') return null;
    return { kind, key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

export function repoGlobalKey(repo: RepoRec): string {
  return `${repo.owner}/${repo.name}`;
}

export function issueGlobalKey(repo: RepoRec, issue: IssueRec): string {
  return `${repo.owner}/${repo.name}#${issue.number}`;
}

export function pullGlobalKey(repo: RepoRec, pull: PullRec): string {
  return `${repo.owner}/${repo.name}#${pull.number}`;
}

export function commentGlobalKey(repo: RepoRec, issue: IssueRec, comment: CommentRec): string {
  return `${repo.owner}/${repo.name}#${issue.number}@${comment.id}`;
}

/** Resolve a global id back to its record, or null when it names nothing here. */
export function resolveGlobalId(
  id: string,
): { kind: GlobalIdKind; repo: RepoRec; issue?: IssueRec; pull?: PullRec; comment?: CommentRec } | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null) return null;
  const { kind, key } = decoded;
  if (kind === 'Repository') {
    const slash = key.indexOf('/');
    if (slash < 0) return null;
    const repo = store.getRepo(key.slice(0, slash), key.slice(slash + 1));
    return repo === undefined ? null : { kind, repo };
  }
  const hash = key.lastIndexOf('#');
  if (hash < 0) return null;
  const repoPart = key.slice(0, hash);
  const slash = repoPart.indexOf('/');
  if (slash < 0) return null;
  const repo = store.getRepo(repoPart.slice(0, slash), repoPart.slice(slash + 1));
  if (repo === undefined) return null;
  const rest = key.slice(hash + 1);
  if (kind === 'Issue') {
    const issue = repo.issues.get(Number(rest));
    return issue === undefined ? null : { kind, repo, issue };
  }
  if (kind === 'PullRequest') {
    const pull = repo.pulls.get(Number(rest));
    return pull === undefined ? null : { kind, repo, pull };
  }
  const at = rest.indexOf('@');
  if (at < 0) return null;
  const issue = repo.issues.get(Number(rest.slice(0, at)));
  if (issue === undefined) return null;
  const comment = issue.comments.find((entry) => entry.id === Number(rest.slice(at + 1)));
  return comment === undefined ? null : { kind, repo, issue, comment };
}
