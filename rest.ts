// The GitHub REST v3 surface under /api/v3: repositories, branches, commits,
// contents, labels, issues, comments and pull requests. Every handler works
// on the shared store (through ops.ts), so state created here is visible to
// the git, GraphQL and MCP surfaces unchanged. Errors are JSON {"message"}
// bodies, as the protocol checks require.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { commitTree, flattenTree, parseCommit, parseTree, walkHistory } from './gitcore.ts';
import { readBody, requestUrl, sendError, sendJson } from './httputil.ts';
import {
  OpError,
  branchTree,
  commitFileChange,
  createIssueRecord,
  createPullRecord,
  fileBlobAt,
  mergePullRecord,
  pullFiles,
  pullTips,
} from './ops.ts';
import { store, type IssueRec, type PullRec, type RepoRec } from './store.ts';

// ---------------------------------------------------------------------------
// serializers

export function repoJson(repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: store.viewer.id },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: store.isoAt(repo.seq),
    updated_at: store.isoAt(repo.seq),
  };
}

export function issueJson(repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed' };
    }),
    user: { login: repo.owner, id: store.viewer.id },
    comments: issue.comments.length,
    created_at: store.isoAt(issue.seq),
    updated_at: store.isoAt(issue.seq),
  };
}

export function pullJson(repo: RepoRec, pull: PullRec): Record<string, unknown> {
  const tips = pullTips(repo, pull);
  return {
    id: pull.id,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: { ref: pull.headRef, sha: tips.head ?? '', label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: tips.base ?? '', label: `${repo.owner}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: { login: repo.owner, id: store.viewer.id },
    created_at: store.isoAt(pull.seq),
    updated_at: store.isoAt(pull.seq),
  };
}

// ---------------------------------------------------------------------------
// helpers

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  segments: string[];
  query: URLSearchParams;
  body: Record<string, unknown>;
}

function notFound(res: ServerResponse): void {
  sendError(res, 404, 'Not Found');
}

function repoOf(ctx: Ctx): RepoRec | null {
  const owner = ctx.segments[1] ?? '';
  const name = ctx.segments[2] ?? '';
  const repo = store.getRepo(owner, name);
  if (repo === undefined) {
    notFound(ctx.res);
    return null;
  }
  return repo;
}

function pageParams(query: URLSearchParams): { page: number; perPage: number } {
  const perPageRaw = Number(query.get('per_page') ?? '30');
  const pageRaw = Number(query.get('page') ?? '1');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.trunc(perPageRaw)) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1;
  return { page, perPage };
}

function paginate<T>(items: readonly T[], query: URLSearchParams): T[] {
  const { page, perPage } = pageParams(query);
  return items.slice((page - 1) * perPage, page * perPage);
}

function stringField(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  return typeof value === 'string' ? value : undefined;
}

// ---------------------------------------------------------------------------
// repositories

function listUserRepos(ctx: Ctx): void {
  const repos = store.viewerRepos();
  const { page, perPage } = pageParams(ctx.query);
  const slice = repos.slice((page - 1) * perPage, page * perPage);
  const headers: Record<string, string> = {};
  if (page * perPage < repos.length) {
    const host = ctx.req.headers.host ?? 'entry';
    const next = `http://${host}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}`;
    const lastPage = Math.ceil(repos.length / perPage);
    const last = `http://${host}/api/v3/user/repos?per_page=${perPage}&page=${lastPage}`;
    headers.link = `<${next}>; rel="next", <${last}>; rel="last"`;
  }
  sendJson(ctx.res, 200, slice.map(repoJson), headers);
}

function createRepo(ctx: Ctx): void {
  const name = stringField(ctx.body, 'name');
  if (name === undefined || name === '') {
    sendError(ctx.res, 422, 'Repository name is required');
    return;
  }
  if (store.getRepo(store.viewer.login, name) !== undefined) {
    sendError(ctx.res, 422, 'Repository already exists');
    return;
  }
  const repo = store.createRepo(store.viewer.login, name, {
    description: stringField(ctx.body, 'description') ?? '',
    isPrivate: ctx.body.private === true,
  });
  sendJson(ctx.res, 201, repoJson(repo));
}

function patchRepo(ctx: Ctx, repo: RepoRec): void {
  const description = stringField(ctx.body, 'description');
  if (description !== undefined) repo.description = description;
  const name = stringField(ctx.body, 'name');
  if (name !== undefined && name !== '' && name !== repo.name) {
    store.repos.delete(store.repoKey(repo.owner, repo.name));
    repo.name = name;
    store.repos.set(store.repoKey(repo.owner, repo.name), repo);
  }
  if (typeof ctx.body.private === 'boolean') repo.isPrivate = ctx.body.private;
  sendJson(ctx.res, 200, repoJson(repo));
}

// ---------------------------------------------------------------------------
// branches, refs, commits

function listBranches(ctx: Ctx, repo: RepoRec): void {
  const branches: Record<string, unknown>[] = [];
  for (const [ref, oid] of repo.refs) {
    if (!ref.startsWith('refs/heads/')) continue;
    branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha: oid } });
  }
  branches.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  sendJson(ctx.res, 200, branches);
}

function getBranch(ctx: Ctx, repo: RepoRec, branch: string): void {
  const oid = repo.refs.get(`refs/heads/${branch}`);
  if (oid === undefined) {
    notFound(ctx.res);
    return;
  }
  sendJson(ctx.res, 200, { name: branch, commit: { sha: oid } });
}

function createRef(ctx: Ctx, repo: RepoRec): void {
  const ref = stringField(ctx.body, 'ref');
  const sha = stringField(ctx.body, 'sha');
  if (ref === undefined || sha === undefined || !ref.startsWith('refs/')) {
    sendError(ctx.res, 422, 'A ref and a sha are required');
    return;
  }
  if (repo.objects.get(sha) === undefined) {
    sendError(ctx.res, 422, `Object ${sha} does not exist`);
    return;
  }
  if (repo.refs.has(ref)) {
    sendError(ctx.res, 422, 'Reference already exists');
    return;
  }
  repo.refs.set(ref, sha);
  sendJson(ctx.res, 201, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
}

function getRef(ctx: Ctx, repo: RepoRec, refPath: string): void {
  const ref = `refs/${refPath}`;
  const oid = repo.refs.get(ref);
  if (oid === undefined) {
    notFound(ctx.res);
    return;
  }
  sendJson(ctx.res, 200, { ref, object: { sha: oid, type: repo.objects.get(oid)?.type ?? 'commit' } });
}

function listCommits(ctx: Ctx, repo: RepoRec): void {
  const shaParam = ctx.query.get('sha');
  let tip: string | null = null;
  if (shaParam !== null && shaParam !== '') {
    tip = repo.refs.get(`refs/heads/${shaParam}`) ?? (repo.objects.get(shaParam)?.type === 'commit' ? shaParam : null);
  } else {
    tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  }
  if (tip === null) {
    sendJson(ctx.res, 200, []);
    return;
  }
  const commits = walkHistory(repo, tip).map((oid) => {
    const view = parseCommit((repo.objects.get(oid) as { data: Buffer }).data);
    const identity = (line: string): Record<string, unknown> => {
      const match = /^(.*?) <(.*?)> (\d+) /.exec(line);
      return {
        name: match?.[1] ?? '',
        email: match?.[2] ?? '',
        date: new Date(Number(match?.[3] ?? '0') * 1000).toISOString(),
      };
    };
    return {
      sha: oid,
      commit: { message: view.message, author: identity(view.author), committer: identity(view.committer), tree: { sha: view.tree } },
      parents: view.parents.map((parent) => ({ sha: parent })),
    };
  });
  sendJson(ctx.res, 200, paginate(commits, ctx.query));
}

// ---------------------------------------------------------------------------
// contents

function contentsGet(ctx: Ctx, repo: RepoRec, path: string): void {
  const refParam = ctx.query.get('ref');
  let tree: string | null;
  if (refParam !== null && refParam !== '') {
    tree = branchTree(repo, refParam);
    if (tree === null && repo.objects.get(refParam)?.type === 'commit') tree = commitTree(repo, refParam);
  } else {
    tree = branchTree(repo, repo.defaultBranch);
  }
  if (tree === null) {
    notFound(ctx.res);
    return;
  }
  const flat = flattenTree(repo, tree);
  const target = flat.get(path);
  if (target !== undefined) {
    const blob = repo.objects.get(target.oid);
    if (blob === undefined) {
      notFound(ctx.res);
      return;
    }
    sendJson(ctx.res, 200, {
      type: 'file',
      name: path.split('/').pop() ?? path,
      path,
      sha: target.oid,
      size: blob.data.length,
      encoding: 'base64',
      content: blob.data.toString('base64'),
    });
    return;
  }
  // Directory listing: the immediate children of `path`.
  const prefix = path === '' ? '' : `${path}/`;
  const children = new Map<string, { type: 'file' | 'dir'; sha: string; size: number }>();
  for (const [filePath, value] of flat) {
    if (!filePath.startsWith(prefix)) continue;
    const rest = filePath.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) {
      children.set(rest, { type: 'file', sha: value.oid, size: repo.objects.get(value.oid)?.data.length ?? 0 });
    } else {
      const dir = rest.slice(0, slash);
      if (!children.has(dir)) children.set(dir, { type: 'dir', sha: dirTreeSha(repo, tree, prefix + dir), size: 0 });
    }
  }
  if (children.size === 0 && path !== '') {
    notFound(ctx.res);
    return;
  }
  const entries = [...children.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => ({ type: value.type, name, path: prefix + name, sha: value.sha, size: value.size }));
  sendJson(ctx.res, 200, entries);
}

/** The tree oid at a directory path inside a root tree. */
function dirTreeSha(repo: RepoRec, rootTree: string, dirPath: string): string {
  let current = rootTree;
  for (const segment of dirPath.split('/').filter(Boolean)) {
    const tree = repo.objects.get(current);
    if (tree === undefined || tree.type !== 'tree') return current;
    const entry = parseTree(tree.data).find((candidate) => candidate.name === segment);
    if (entry === undefined) return current;
    current = entry.oid;
  }
  return current;
}

function contentsPut(ctx: Ctx, repo: RepoRec, path: string): void {
  const message = stringField(ctx.body, 'message') ?? 'Update file';
  const contentField = stringField(ctx.body, 'content');
  if (contentField === undefined) {
    sendError(ctx.res, 422, 'Content is required');
    return;
  }
  const branch = stringField(ctx.body, 'branch') ?? repo.defaultBranch;
  const providedSha = stringField(ctx.body, 'sha');
  const current = fileBlobAt(repo, branch, path);
  if (current !== null && providedSha !== undefined && providedSha !== current) {
    sendError(ctx.res, 409, 'The sha does not match the current file');
    return;
  }
  const data = Buffer.from(contentField.replace(/\s+/g, ''), 'base64');
  const commitSha = commitFileChange(repo, branch, path, data, message);
  const blobOid = fileBlobAt(repo, branch, path) as string;
  sendJson(ctx.res, current === null ? 201 : 200, {
    content: { name: path.split('/').pop() ?? path, path, sha: blobOid, size: data.length, type: 'file', encoding: 'base64' },
    commit: { sha: commitSha },
  });
}

function contentsDelete(ctx: Ctx, repo: RepoRec, path: string): void {
  const message = stringField(ctx.body, 'message') ?? 'Delete file';
  const branch = stringField(ctx.body, 'branch') ?? repo.defaultBranch;
  const providedSha = stringField(ctx.body, 'sha');
  const current = fileBlobAt(repo, branch, path);
  if (current === null) {
    notFound(ctx.res);
    return;
  }
  if (providedSha !== undefined && providedSha !== current) {
    sendError(ctx.res, 409, 'The sha does not match the current file');
    return;
  }
  const commitSha = commitFileChange(repo, branch, path, null, message);
  sendJson(ctx.res, 200, { content: null, commit: { sha: commitSha } });
}

// ---------------------------------------------------------------------------
// labels, issues, comments

function createLabel(ctx: Ctx, repo: RepoRec): void {
  const name = stringField(ctx.body, 'name');
  if (name === undefined || name === '') {
    sendError(ctx.res, 422, 'Label name is required');
    return;
  }
  if (repo.labels.has(name)) {
    sendError(ctx.res, 422, 'Label already exists');
    return;
  }
  const color = stringField(ctx.body, 'color') ?? 'ededed';
  repo.labels.set(name, { name, color });
  sendJson(ctx.res, 201, { name, color });
}

function createIssue(ctx: Ctx, repo: RepoRec): void {
  const title = stringField(ctx.body, 'title');
  if (title === undefined) {
    sendError(ctx.res, 422, 'Title is required');
    return;
  }
  const labels = Array.isArray(ctx.body.labels) ? (ctx.body.labels as unknown[]).filter((entry): entry is string => typeof entry === 'string') : [];
  try {
    const issue = createIssueRecord(repo, { title, body: stringField(ctx.body, 'body') ?? '', labels });
    sendJson(ctx.res, 201, issueJson(repo, issue));
  } catch (err) {
    if (err instanceof OpError) sendError(ctx.res, err.status, err.message);
    else throw err;
  }
}

function listIssues(ctx: Ctx, repo: RepoRec): void {
  const state = ctx.query.get('state') ?? 'open';
  const direction = ctx.query.get('direction') ?? 'desc';
  let issues = [...repo.issues.values()];
  if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
  issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
  sendJson(ctx.res, 200, paginate(issues, ctx.query).map((issue) => issueJson(repo, issue)));
}

function getIssue(ctx: Ctx, repo: RepoRec, number: number): IssueRec | null {
  const issue = repo.issues.get(number);
  if (issue === undefined) {
    notFound(ctx.res);
    return null;
  }
  return issue;
}

function patchIssue(ctx: Ctx, repo: RepoRec, issue: IssueRec): void {
  const state = stringField(ctx.body, 'state');
  if (state === 'open' || state === 'closed') issue.state = state;
  const title = stringField(ctx.body, 'title');
  if (title !== undefined) issue.title = title;
  const body = stringField(ctx.body, 'body');
  if (body !== undefined) issue.body = body;
  sendJson(ctx.res, 200, issueJson(repo, issue));
}

function createComment(ctx: Ctx, repo: RepoRec, issue: IssueRec): void {
  const body = stringField(ctx.body, 'body');
  if (body === undefined) {
    sendError(ctx.res, 422, 'Body is required');
    return;
  }
  const comment = { id: store.newCommentId(), body, seq: store.nextSeq() };
  issue.comments.push(comment);
  sendJson(ctx.res, 201, {
    id: comment.id,
    body: comment.body,
    user: { login: repo.owner, id: store.viewer.id },
    created_at: store.isoAt(comment.seq),
    updated_at: store.isoAt(comment.seq),
  });
}

function listComments(ctx: Ctx, repo: RepoRec, issue: IssueRec): void {
  sendJson(
    ctx.res,
    200,
    issue.comments.map((comment) => ({
      id: comment.id,
      body: comment.body,
      user: { login: repo.owner, id: store.viewer.id },
      created_at: store.isoAt(comment.seq),
      updated_at: store.isoAt(comment.seq),
    })),
  );
}

// ---------------------------------------------------------------------------
// pull requests

function createPull(ctx: Ctx, repo: RepoRec): void {
  const title = stringField(ctx.body, 'title');
  const head = stringField(ctx.body, 'head');
  const base = stringField(ctx.body, 'base');
  if (title === undefined || head === undefined || base === undefined) {
    sendError(ctx.res, 422, 'Title, head and base are required');
    return;
  }
  try {
    const pull = createPullRecord(repo, { title, body: stringField(ctx.body, 'body') ?? '', head, base });
    sendJson(ctx.res, 201, pullJson(repo, pull));
  } catch (err) {
    if (err instanceof OpError) sendError(ctx.res, err.status, err.message);
    else throw err;
  }
}

function listPulls(ctx: Ctx, repo: RepoRec): void {
  const state = ctx.query.get('state') ?? 'open';
  let pulls = [...repo.pulls.values()];
  if (state === 'open' || state === 'closed') pulls = pulls.filter((pull) => pull.state === state);
  pulls.sort((a, b) => b.seq - a.seq);
  sendJson(ctx.res, 200, paginate(pulls, ctx.query).map((pull) => pullJson(repo, pull)));
}

function getPull(ctx: Ctx, repo: RepoRec, number: number): PullRec | null {
  const pull = repo.pulls.get(number);
  if (pull === undefined) {
    notFound(ctx.res);
    return null;
  }
  return pull;
}

function pullFilesResponse(ctx: Ctx, repo: RepoRec, pull: PullRec): void {
  const files = pullFiles(repo, pull).map((change) => ({
    filename: change.path,
    status: change.status === 'modified' ? 'modified' : change.status,
    additions: change.additions,
    deletions: change.deletions,
    changes: change.additions + change.deletions,
  }));
  sendJson(ctx.res, 200, files);
}

function mergePull(ctx: Ctx, repo: RepoRec, pull: PullRec): void {
  try {
    const { sha } = mergePullRecord(repo, pull);
    sendJson(ctx.res, 200, { sha, merged: true, message: 'Pull Request successfully merged' });
  } catch (err) {
    if (err instanceof OpError) sendError(ctx.res, err.status, err.message);
    else throw err;
  }
}

// ---------------------------------------------------------------------------
// routing

/** Handle one /api/v3 request (authentication already verified by app.ts). */
export async function handleRest(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  const url = requestUrl(req);
  const method = req.method ?? 'GET';
  const rest = path.replace(/^\/api\/v3\/?/, '');
  const segments = rest === '' ? [] : rest.split('/').map((segment) => decodeURIComponent(segment));

  let body: Record<string, unknown> = {};
  if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
    const raw = await readBody(req);
    if (raw.length > 0) {
      try {
        const parsed = JSON.parse(raw.toString('utf8')) as unknown;
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
        body = parsed as Record<string, unknown>;
      } catch {
        sendError(res, 400, 'Problems parsing JSON');
        return;
      }
    }
  }
  const ctx: Ctx = { req, res, segments, query: url.searchParams, body };

  if (segments.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
      return;
    }
    notFound(res);
    return;
  }
  if (segments[0] === 'meta' && segments.length === 1 && method === 'GET') {
    sendJson(res, 200, { installed_version: '1.0.0', github_deployment: false });
    return;
  }
  if (segments[0] === 'user' && segments.length === 1 && method === 'GET') {
    sendJson(res, 200, { login: store.viewer.login, id: store.viewer.id, name: store.viewer.name, email: store.viewer.email, type: 'User' });
    return;
  }
  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (method === 'GET') return listUserRepos(ctx);
    if (method === 'POST') return createRepo(ctx);
  }
  if (segments[0] === 'repos' && segments.length >= 3) {
    const repo = repoOf(ctx);
    if (repo === null) return;
    const tail = segments.slice(3);
    if (tail.length === 0) {
      if (method === 'GET') return void sendJson(res, 200, repoJson(repo));
      if (method === 'PATCH') return patchRepo(ctx, repo);
      if (method === 'DELETE') {
        store.deleteRepo(repo.owner, repo.name);
        res.writeHead(204, { 'x-github-request-id': 'FORGE' });
        res.end();
        return;
      }
    }
    if (tail[0] === 'branches') {
      if (tail.length === 1 && method === 'GET') return listBranches(ctx, repo);
      if (tail.length >= 2 && method === 'GET') return getBranch(ctx, repo, tail.slice(1).join('/'));
    }
    if (tail[0] === 'commits' && tail.length === 1 && method === 'GET') return listCommits(ctx, repo);
    if (tail[0] === 'git' && tail[1] === 'refs') {
      if (tail.length === 2 && method === 'POST') return createRef(ctx, repo);
      if (tail.length >= 3 && method === 'GET') return getRef(ctx, repo, tail.slice(2).join('/'));
    }
    if (tail[0] === 'contents') {
      const contentPath = tail.slice(1).join('/');
      if (method === 'GET') return contentsGet(ctx, repo, contentPath);
      if (method === 'PUT') return contentsPut(ctx, repo, contentPath);
      if (method === 'DELETE') return contentsDelete(ctx, repo, contentPath);
    }
    if (tail[0] === 'labels' && tail.length === 1) {
      if (method === 'POST') return createLabel(ctx, repo);
      if (method === 'GET') return void sendJson(res, 200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })));
    }
    if (tail[0] === 'issues') {
      if (tail.length === 1) {
        if (method === 'POST') return createIssue(ctx, repo);
        if (method === 'GET') return listIssues(ctx, repo);
      }
      if (tail.length >= 2) {
        const issue = getIssue(ctx, repo, Number(tail[1]));
        if (issue === null) return;
        if (tail.length === 2) {
          if (method === 'GET') return void sendJson(res, 200, issueJson(repo, issue));
          if (method === 'PATCH') return patchIssue(ctx, repo, issue);
        }
        if (tail.length === 3 && tail[2] === 'comments') {
          if (method === 'POST') return createComment(ctx, repo, issue);
          if (method === 'GET') return listComments(ctx, repo, issue);
        }
      }
    }
    if (tail[0] === 'pulls') {
      if (tail.length === 1) {
        if (method === 'POST') return createPull(ctx, repo);
        if (method === 'GET') return listPulls(ctx, repo);
      }
      if (tail.length >= 2) {
        const pull = getPull(ctx, repo, Number(tail[1]));
        if (pull === null) return;
        if (tail.length === 2 && method === 'GET') return void sendJson(res, 200, pullJson(repo, pull));
        if (tail.length === 3 && tail[2] === 'files' && method === 'GET') return pullFilesResponse(ctx, repo, pull);
        if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') return mergePull(ctx, repo, pull);
      }
    }
  }
  notFound(res);
}
