// Domain operations shared by the REST, GraphQL and MCP surfaces: committing
// file changes, opening issues and pull requests, and squash-merging a pull
// request. Each operation mutates the one store, so every surface sees the
// same state. Errors are thrown as OpError with an HTTP-ish status the REST
// layer maps directly; the other surfaces translate them to their own
// error shapes.

import {
  buildCommitData,
  buildTreeFromFlat,
  commitTree,
  diffTrees,
  flattenTree,
  isAncestor,
  mergeBase,
  mergeTrees,
  parseCommit,
  peelToCommit,
  putObject,
  refCommit,
  type FileChange,
} from './gitcore.ts';
import { store, type IssueRec, type PullRec, type RepoRec } from './store.ts';

export class OpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const EPOCH_BASE = 1735689600; // matches store.ts's logical clock base.

/** The author/committer line for a forge-made commit at a sequence stamp. */
export function authorLine(seq: number): string {
  return `${store.viewer.name} <${store.viewer.email}> ${EPOCH_BASE + seq} +0000`;
}

/** The tree a branch tip holds, or null for an unborn/absent branch. */
export function branchTree(repo: RepoRec, branch: string): string | null {
  const commit = refCommit(repo, `refs/heads/${branch}`);
  if (commit === null) return null;
  return commitTree(repo, commit);
}

/**
 * Commit one file change (create/update when `content` is a Buffer, delete
 * when null) on a branch. A branch that does not exist yet is created from
 * the default branch's tip; on an unborn repository the commit is a root
 * commit. Returns the new commit's sha.
 */
export function commitFileChange(
  repo: RepoRec,
  branch: string,
  path: string,
  content: Buffer | null,
  message: string,
): string {
  const ref = `refs/heads/${branch}`;
  let parent = refCommit(repo, ref);
  if (parent === null && branch !== repo.defaultBranch) {
    parent = refCommit(repo, `refs/heads/${repo.defaultBranch}`);
  }
  const flat = parent === null ? new Map<string, { oid: string; mode: string }>() : flattenTree(repo, commitTree(repo, parent) as string);
  if (content === null) {
    flat.delete(path);
  } else {
    const existing = flat.get(path);
    const blobOid = putObject(repo, 'blob', content);
    flat.set(path, { oid: blobOid, mode: existing?.mode ?? '100644' });
  }
  const treeOid = buildTreeFromFlat(repo, flat);
  const seq = store.nextSeq();
  const line = authorLine(seq);
  const commitOid = putObject(
    repo,
    'commit',
    buildCommitData({ tree: treeOid, parents: parent === null ? [] : [parent], author: line, committer: line, message }),
  );
  repo.refs.set(ref, commitOid);
  return commitOid;
}

/** The blob oid a path has on a branch, or null. */
export function fileBlobAt(repo: RepoRec, branch: string, path: string): string | null {
  const tree = branchTree(repo, branch);
  if (tree === null) return null;
  return flattenTree(repo, tree).get(path)?.oid ?? null;
}

// ---------------------------------------------------------------------------
// issues

export function createIssueRecord(repo: RepoRec, input: { title: string; body?: string; labels?: readonly string[] }): IssueRec {
  const labels = input.labels ?? [];
  for (const label of labels) {
    if (!repo.labels.has(label)) throw new OpError(422, `Label "${label}" does not exist`);
  }
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const issue: IssueRec = {
    id: store.newIssueId(),
    number,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    labels: [...labels],
    comments: [],
    seq: store.nextSeq(),
  };
  repo.issues.set(number, issue);
  return issue;
}

// ---------------------------------------------------------------------------
// pull requests

export function createPullRecord(repo: RepoRec, input: { title: string; body?: string; head: string; base: string }): PullRec {
  const headCommit = refCommit(repo, `refs/heads/${input.head}`);
  if (headCommit === null) throw new OpError(422, `Head branch "${input.head}" does not exist`);
  const baseCommit = refCommit(repo, `refs/heads/${input.base}`);
  if (baseCommit === null) throw new OpError(422, `Base branch "${input.base}" does not exist`);
  for (const pull of repo.pulls.values()) {
    if (pull.state === 'open' && pull.headRef === input.head && pull.baseRef === input.base) {
      throw new OpError(422, `A pull request already exists for ${input.head} into ${input.base}`);
    }
  }
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const pull: PullRec = {
    id: store.newPullId(),
    number,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    headRef: input.head,
    baseRef: input.base,
    headShaAtCreate: headCommit,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    seq: store.nextSeq(),
  };
  repo.pulls.set(number, pull);
  return pull;
}

/** The current head/base tips of a pull request (falling back to creation-time head). */
export function pullTips(repo: RepoRec, pull: PullRec): { head: string | null; base: string | null } {
  return {
    head: refCommit(repo, `refs/heads/${pull.headRef}`) ?? pull.headShaAtCreate,
    base: refCommit(repo, `refs/heads/${pull.baseRef}`),
  };
}

/** The files a pull request changes: its head tree against the merge base tree. */
export function pullFiles(repo: RepoRec, pull: PullRec): FileChange[] {
  const { head, base } = pullTips(repo, pull);
  if (head === null || base === null) return [];
  const baseOfMerge = mergeBase(repo, head, base) ?? base;
  return diffTrees(repo, commitTree(repo, baseOfMerge), commitTree(repo, head));
}

/** Whether the pull request merges cleanly into its base right now. */
export function pullMergeable(repo: RepoRec, pull: PullRec): boolean {
  if (pull.state !== 'open') return false;
  const { head, base } = pullTips(repo, pull);
  if (head === null || base === null) return false;
  if (isAncestor(repo, head, base)) return true; // already up to date
  const baseOfMerge = mergeBase(repo, head, base);
  const outcome = mergeTrees(
    repo,
    baseOfMerge === null ? null : commitTree(repo, baseOfMerge),
    commitTree(repo, base),
    commitTree(repo, head),
  );
  return outcome.treeOid !== null;
}

/**
 * Squash-merge a pull request: one commit on the base branch whose tree is
 * the three-way merge of the merge base, the base tip and the head tip.
 * Throws OpError 404/405 in the suite's cases (unknown or conflicted).
 */
export function mergePullRecord(repo: RepoRec, pull: PullRec): { sha: string } {
  if (pull.state !== 'open' || pull.merged) throw new OpError(405, 'Pull request is not mergeable');
  const { head, base } = pullTips(repo, pull);
  if (head === null || base === null) throw new OpError(405, 'Pull request is not mergeable');
  let mergedTree: string | null;
  if (isAncestor(repo, head, base)) {
    mergedTree = commitTree(repo, base);
  } else {
    const baseOfMerge = mergeBase(repo, head, base);
    const outcome = mergeTrees(
      repo,
      baseOfMerge === null ? null : commitTree(repo, baseOfMerge),
      commitTree(repo, base),
      commitTree(repo, head),
    );
    if (outcome.treeOid === null) throw new OpError(405, 'Pull request has conflicts');
    mergedTree = outcome.treeOid;
  }
  const seq = store.nextSeq();
  const line = authorLine(seq);
  const message = `${pull.title} (#${pull.number})\n`;
  const sha = putObject(repo, 'commit', buildCommitData({ tree: mergedTree as string, parents: [base], author: line, committer: line, message }));
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = store.isoAt(seq);
  pull.mergeCommitSha = sha;
  return { sha };
}

/** Parse a commit for display: message plus author identity parts. */
export function commitDisplay(repo: RepoRec, oid: string): { message: string; authorLine: string } | null {
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'commit') return null;
  const view = parseCommit(object.data);
  return { message: view.message, authorLine: view.author };
}

export { peelToCommit };
