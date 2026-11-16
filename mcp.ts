// The MCP endpoint at /mcp: JSON-RPC 2.0 over streamable HTTP. It speaks
// both protocol eras the suite accepts — the modern one (server/discover,
// revision 2026-07-28, no handshake) and the legacy handshake era
// (initialize + notifications/initialized, 2025 revisions). The tools act on
// the same store as the REST and GraphQL surfaces, so an object made over
// MCP is the same object everywhere.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAuthenticated, readBody, sendJson } from './httputil.ts';
import { OpError, createIssueRecord, createPullRecord, mergePullRecord } from './ops.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';
import { store, type RepoRec } from './store.ts';

const SERVER_INFO = { name: 'hesper-forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

type Args = Record<string, unknown>;

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
  run: (args: Args) => unknown;
}

function repoOf(args: Args): RepoRec {
  const repo = store.getRepo(String(args.owner ?? ''), String(args.repo ?? ''));
  if (repo === undefined) throw new OpError(404, `Repository ${String(args.owner)}/${String(args.repo)} not found`);
  return repo;
}

function toolResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    properties: {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    required: ['name'],
    run: (args) => {
      const name = String(args.name ?? '');
      if (name === '') throw new OpError(422, 'A repository name is required');
      if (store.getRepo(store.viewer.login, name) !== undefined) throw new OpError(422, 'Repository already exists');
      const repo = store.createRepo(store.viewer.login, name, {
        description: typeof args.description === 'string' ? args.description : '',
        isPrivate: args.private === true,
      });
      return repoJson(repo);
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
    required: ['owner', 'repo'],
    run: (args) => repoJson(repoOf(args)),
  },
  {
    name: 'list_repos',
    description: 'List the repositories owned by the authenticated user.',
    properties: {},
    required: [],
    run: () => store.viewerRepos().map((repo) => repoJson(repo)),
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
    required: ['owner', 'repo', 'title'],
    run: (args) => {
      const repo = repoOf(args);
      const issue = createIssueRecord(repo, { title: String(args.title ?? ''), body: typeof args.body === 'string' ? args.body : '' });
      return issueJson(repo, issue);
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'Filter by state: open, closed or all.' },
    },
    required: ['owner', 'repo'],
    run: (args) => {
      const repo = repoOf(args);
      const state = typeof args.state === 'string' ? args.state : 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => a.seq - b.seq);
      return issues.map((issue) => issueJson(repo, issue));
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue of a repository by its number.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      issue_number: { type: 'number', description: 'The issue number.' },
    },
    required: ['owner', 'repo', 'issue_number'],
    run: (args) => {
      const repo = repoOf(args);
      const issue = repo.issues.get(Number(args.issue_number));
      if (issue === undefined) throw new OpError(404, 'Issue not found');
      return issueJson(repo, issue);
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      body: { type: 'string', description: 'The pull request body.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
    run: (args) => {
      const repo = repoOf(args);
      const pull = createPullRecord(repo, {
        title: String(args.title ?? ''),
        body: typeof args.body === 'string' ? args.body : '',
        head: String(args.head ?? ''),
        base: String(args.base ?? ''),
      });
      return pullJson(repo, pull);
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request into its base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'number', description: 'The pull request number.' },
    },
    required: ['owner', 'repo', 'pull_number'],
    run: (args) => {
      const repo = repoOf(args);
      const pull = repo.pulls.get(Number(args.pull_number));
      if (pull === undefined) throw new OpError(404, 'Pull request not found');
      const { sha } = mergePullRecord(repo, pull);
      return { ...pullJson(repo, pull), sha, merged: true, message: 'Pull Request successfully merged' };
    },
  },
];

/** The tools/list payload: a constant, so two calls are byte-identical. */
const TOOLS_LIST = {
  tools: TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: {
      type: 'object',
      properties: tool.properties,
      required: tool.required,
      additionalProperties: false,
    },
  })),
};

interface RpcOutcome {
  status: number;
  payload: Record<string, unknown> | null;
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

/** Handle one JSON-RPC message; a null payload means "no reply" (a notification). */
function handleMessage(message: Args): RpcOutcome {
  const id = message.id;
  const method = typeof message.method === 'string' ? message.method : '';
  const params = (typeof message.params === 'object' && message.params !== null ? message.params : {}) as Args;
  const isNotification = id === undefined;
  switch (method) {
    case 'server/discover':
      return {
        status: 200,
        payload: rpcResult(id, {
          resultType: 'complete',
          supportedVersions: SUPPORTED_VERSIONS,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
        }),
      };
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const chosen = SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25';
      return { status: 200, payload: rpcResult(id, { protocolVersion: chosen, capabilities: { tools: {} }, serverInfo: SERVER_INFO }) };
    }
    case 'ping':
      return { status: 200, payload: rpcResult(id, {}) };
    case 'tools/list':
      return { status: 200, payload: rpcResult(id, TOOLS_LIST) };
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const tool = TOOLS.find((candidate) => candidate.name === name);
      if (tool === undefined) return { status: 200, payload: rpcError(id, -32602, `Unknown tool: ${name}`) };
      const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Args;
      const missing = tool.required.filter((field) => args[field] === undefined || args[field] === null || args[field] === '');
      if (missing.length > 0) return { status: 200, payload: rpcError(id, -32602, `Missing required argument(s): ${missing.join(', ')}`) };
      try {
        return { status: 200, payload: rpcResult(id, toolResult(tool.run(args))) };
      } catch (err) {
        if (err instanceof OpError) return { status: 200, payload: rpcResult(id, toolError(err.message)) };
        return { status: 200, payload: rpcResult(id, toolError(err instanceof Error ? err.message : 'Tool failed')) };
      }
    }
    default:
      if (isNotification) return { status: 202, payload: null };
      return { status: 200, payload: rpcError(id, -32601, `Method not found: ${method}`) };
  }
}

/** Handle one POST /mcp request. */
export async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!isAuthenticated(req)) {
    sendJson(res, 401, rpcError(null, -32001, 'Unauthorized'));
    return;
  }
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, rpcError(null, -32700, 'Parse error'));
    return;
  }
  if (Array.isArray(parsed)) {
    const replies: Record<string, unknown>[] = [];
    for (const entry of parsed) {
      if (typeof entry !== 'object' || entry === null) continue;
      const outcome = handleMessage(entry as Args);
      if (outcome.payload !== null) replies.push(outcome.payload);
    }
    sendJson(res, 200, replies);
    return;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    sendJson(res, 400, rpcError(null, -32700, 'Parse error'));
    return;
  }
  const outcome = handleMessage(parsed as Args);
  if (outcome.payload === null) {
    res.writeHead(202, { 'x-github-request-id': 'FORGE' });
    res.end();
    return;
  }
  sendJson(res, outcome.status, outcome.payload);
}
