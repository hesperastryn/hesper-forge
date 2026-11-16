// A compact GraphQL engine for the forge: a lexer/parser for the document
// shapes gh and github-mcp-server send (operations with variables, aliases,
// inline and named fragments, enum and input-object literals, introspection)
// and a schema-driven executor over the shared store. No library — the
// contest forbids dependencies — and no dynamic code generation.

import { mergePullRecord, createIssueRecord, createPullRecord, pullFiles, pullMergeable } from './ops.ts';
import {
  commentGlobalKey,
  encodeGlobalId,
  issueGlobalKey,
  pullGlobalKey,
  repoGlobalKey,
  resolveGlobalId,
  store,
  type IssueRec,
  type PullRec,
  type RepoRec,
} from './store.ts';

// ---------------------------------------------------------------------------
// lexer

type TokenKind = 'name' | 'string' | 'int' | 'float' | 'punct' | 'spread' | 'eof';

interface Token {
  kind: TokenKind;
  value: string;
}

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < input.length) {
    const c = input[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (input.startsWith('...', i)) {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (input.startsWith('"""', i)) {
        const end = input.indexOf('"""', i + 3);
        if (end === -1) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: input.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\') {
          const esc = input[j + 1] as string;
          const escapes: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (esc === 'u') {
            value += String.fromCharCode(parseInt(input.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            value += escapes[esc] ?? esc;
            j += 2;
          }
        } else {
          value += input[j];
          j += 1;
        }
      }
      if (j >= input.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      let isFloat = false;
      while (j < input.length && /[0-9.]/.test(input[j] as string)) {
        if (input[j] === '.') isFloat = true;
        j += 1;
      }
      if (input[j] === 'e' || input[j] === 'E') {
        isFloat = true;
        j += 1;
        if (input[j] === '+' || input[j] === '-') j += 1;
        while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < input.length && isNameChar(input[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------------------
// parser

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

export interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: { name: string; value: ValueNode }[];
  selectionSet: SelectionNode[] | null;
}

export type SelectionNode =
  | FieldNode
  | { kind: 'inlineFragment'; typeCondition: string | null; selectionSet: SelectionNode[] }
  | { kind: 'fragmentSpread'; name: string };

export interface OperationNode {
  operation: 'query' | 'mutation';
  name: string | null;
  selectionSet: SelectionNode[];
}

export interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, { typeCondition: string; selectionSet: SelectionNode[] }>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected "${value}", got "${token.value}"`);
  }

  private skipPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name, got "${token.value}"`);
    return token.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, { typeCondition: string; selectionSet: SelectionNode[] }>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ operation: 'query', name: null, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        this.next();
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value;
        if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseVariableDefinitions();
        this.skipDirectives();
        operations.push({ operation: token.value as 'query' | 'mutation', name, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const fragName = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('expected "on" in fragment definition');
        const typeCondition = this.expectName();
        this.skipDirectives();
        fragments.set(fragName, { typeCondition, selectionSet: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`unexpected token "${token.value}"`);
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): void {
    this.expectPunct('(');
    while (!this.skipPunct(')')) {
      this.expectPunct('$');
      this.expectName();
      this.expectPunct(':');
      this.parseType();
      if (this.skipPunct('=')) this.parseValue();
      this.skipDirectives();
    }
  }

  private parseType(): void {
    if (this.skipPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.skipPunct('!');
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
  }

  private parseArguments(): { name: string; value: ValueNode }[] {
    const args: { name: string; value: ValueNode }[] = [];
    this.expectPunct('(');
    while (!this.skipPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    return args;
  }

  private parseSelectionSet(): SelectionNode[] {
    const selections: SelectionNode[] = [];
    this.expectPunct('{');
    while (!this.skipPunct('}')) {
      const token = this.peek();
      if (token.kind === 'spread') {
        this.next();
        if (this.peek().kind === 'name' && this.peek().value === 'on') {
          this.next();
          const typeCondition = this.expectName();
          this.skipDirectives();
          selections.push({ kind: 'inlineFragment', typeCondition, selectionSet: this.parseSelectionSet() });
        } else if (this.peek().kind === 'name') {
          const name = this.next().value;
          this.skipDirectives();
          selections.push({ kind: 'fragmentSpread', name });
        } else {
          selections.push({ kind: 'inlineFragment', typeCondition: null, selectionSet: this.parseSelectionSet() });
        }
        continue;
      }
      let alias: string | null = null;
      let name = this.expectName();
      if (this.skipPunct(':')) {
        alias = name;
        name = this.expectName();
      }
      const args = this.peek().kind === 'punct' && this.peek().value === '(' ? this.parseArguments() : [];
      this.skipDirectives();
      const selectionSet = this.peek().kind === 'punct' && this.peek().value === '{' ? this.parseSelectionSet() : null;
      selections.push({ kind: 'field', alias, name, args, selectionSet });
    }
    return selections;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'int') return { kind: 'int', value: parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: parseFloat(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!this.skipPunct(']')) values.push(this.parseValue());
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!this.skipPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token "${token.value}"`);
  }
}

export function parseGraphQL(source: string): DocumentNode {
  return new Parser(lex(source)).parseDocument();
}

/** Resolve an AST value against the request's variables. */
export function valueOf(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((value) => valueOf(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueOf(field.value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------
// executor

export class GqlError extends Error {}

type AnyRecord = Record<string, unknown>;

interface FieldDef {
  type: string;
  resolve: (source: AnyRecord, args: AnyRecord) => unknown;
}

type SchemaMap = Record<string, Record<string, FieldDef>>;

const SCALARS = new Set(['String', 'Int', 'Float', 'Boolean', 'ID']);

interface ExecCtx {
  variables: AnyRecord;
  fragments: Map<string, { typeCondition: string; selectionSet: SelectionNode[] }>;
  errors: { message: string }[];
}

function namedTypeOf(type: string): string {
  return type.replace(/[[\]!]/g, '');
}

function isListType(type: string): boolean {
  return type.trim().startsWith('[');
}

// Tagged runtime values: every object the resolvers hand back carries its
// GraphQL type under __type, which drives fragment matching and completion.
function tagged(type: string, fields: AnyRecord): AnyRecord {
  return { __type: type, ...fields };
}

function userWrapper(login: string): AnyRecord {
  return tagged('User', { login });
}

function repoWrapper(repo: RepoRec): AnyRecord {
  return tagged('Repository', { repo });
}

function issueWrapper(repo: RepoRec, issue: IssueRec): AnyRecord {
  return tagged('Issue', { repo, issue });
}

function pullWrapper(repo: RepoRec, pull: PullRec): AnyRecord {
  return tagged('PullRequest', { repo, pull });
}

function commentWrapper(repo: RepoRec, issue: IssueRec, comment: { id: number; body: string; seq: number }): AnyRecord {
  return tagged('IssueComment', { repo, issue, comment });
}

function cursorOf(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function numberOfCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

function pageInfoWrapper(hasNextPage: boolean, hasPreviousPage: boolean, startCursor: string | null, endCursor: string | null): AnyRecord {
  return tagged('PageInfo', { hasNextPage, hasPreviousPage, startCursor, endCursor });
}

// ---------------------------------------------------------------------------
// the schema

const TYPE_INFO: Record<string, { kind: 'OBJECT' | 'ENUM'; fields?: string[]; enumValues?: string[] }> = {
  Query: { kind: 'OBJECT', fields: ['viewer', 'repository', 'node'] },
  Mutation: { kind: 'OBJECT', fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'] },
  User: { kind: 'OBJECT', fields: ['id', 'login', 'name', 'email'] },
  Repository: {
    kind: 'OBJECT',
    fields: [
      'id',
      'databaseId',
      'name',
      'nameWithOwner',
      'owner',
      'isPrivate',
      'description',
      'defaultBranchRef',
      'viewerPermission',
      'hasIssuesEnabled',
      'issue',
      'issues',
      'pullRequest',
      'pullRequests',
    ],
  },
  Ref: { kind: 'OBJECT', fields: ['name', 'prefix'] },
  Issue: { kind: 'OBJECT', fields: ['id', 'number', 'title', 'state', 'body'] },
  PullRequest: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files'],
  },
  IssueComment: { kind: 'OBJECT', fields: ['id', 'body'] },
  IssueConnection: { kind: 'OBJECT', fields: ['nodes', 'pageInfo', 'totalCount'] },
  PullRequestConnection: { kind: 'OBJECT', fields: ['nodes', 'pageInfo', 'totalCount'] },
  PullRequestChangedFileConnection: { kind: 'OBJECT', fields: ['nodes', 'totalCount'] },
  PullRequestChangedFile: { kind: 'OBJECT', fields: ['path', 'additions', 'deletions'] },
  PageInfo: { kind: 'OBJECT', fields: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'] },
  CreateIssuePayload: { kind: 'OBJECT', fields: ['issue'] },
  CloseIssuePayload: { kind: 'OBJECT', fields: ['issue'] },
  CreatePullRequestPayload: { kind: 'OBJECT', fields: ['pullRequest'] },
  MergePullRequestPayload: { kind: 'OBJECT', fields: ['pullRequest'] },
  AddCommentPayload: { kind: 'OBJECT', fields: ['commentEdge'] },
  AddCommentEdge: { kind: 'OBJECT', fields: ['node'] },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION'] },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
};

function repoFromGlobalId(id: unknown): RepoRec {
  const resolved = typeof id === 'string' ? resolveGlobalId(id) : null;
  if (resolved === null || resolved.kind !== 'Repository') throw new GqlError('Could not resolve the repository id');
  return resolved.repo;
}

const SCHEMA: SchemaMap = {
  Query: {
    viewer: { type: 'User', resolve: () => userWrapper(store.viewer.login) },
    repository: {
      type: 'Repository',
      resolve: (_source, args) => {
        const repo = store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
        return repo === undefined ? null : repoWrapper(repo);
      },
    },
    node: {
      type: 'Node',
      resolve: (_source, args) => {
        const resolved = typeof args.id === 'string' ? resolveGlobalId(args.id) : null;
        if (resolved === null) return null;
        if (resolved.kind === 'Repository') return repoWrapper(resolved.repo);
        if (resolved.kind === 'Issue' && resolved.issue !== undefined) return issueWrapper(resolved.repo, resolved.issue);
        if (resolved.kind === 'PullRequest' && resolved.pull !== undefined) return pullWrapper(resolved.repo, resolved.pull);
        if (resolved.kind === 'IssueComment' && resolved.issue !== undefined && resolved.comment !== undefined) {
          return commentWrapper(resolved.repo, resolved.issue, resolved.comment);
        }
        return null;
      },
    },
    __type: {
      type: '__Type',
      resolve: (_source, args) => {
        const info = TYPE_INFO[String(args.name ?? '')];
        return info === undefined ? null : tagged('__Type', { name: String(args.name), info });
      },
    },
  },
  Mutation: {
    createIssue: {
      type: 'CreateIssuePayload',
      resolve: (_source, args) => {
        const input = (args.input ?? {}) as AnyRecord;
        const repo = repoFromGlobalId(input.repositoryId);
        const issue = createIssueRecord(repo, { title: String(input.title ?? ''), body: String(input.body ?? '') });
        return tagged('CreateIssuePayload', { issue: issueWrapper(repo, issue) });
      },
    },
    closeIssue: {
      type: 'CloseIssuePayload',
      resolve: (_source, args) => {
        const input = (args.input ?? {}) as AnyRecord;
        const resolved = typeof input.issueId === 'string' ? resolveGlobalId(input.issueId) : null;
        if (resolved === null || resolved.kind !== 'Issue' || resolved.issue === undefined) throw new GqlError('Could not resolve the issue id');
        resolved.issue.state = 'closed';
        return tagged('CloseIssuePayload', { issue: issueWrapper(resolved.repo, resolved.issue) });
      },
    },
    createPullRequest: {
      type: 'CreatePullRequestPayload',
      resolve: (_source, args) => {
        const input = (args.input ?? {}) as AnyRecord;
        const repo = repoFromGlobalId(input.repositoryId);
        const pull = createPullRecord(repo, {
          title: String(input.title ?? ''),
          body: String(input.body ?? ''),
          head: String(input.headRefName ?? ''),
          base: String(input.baseRefName ?? ''),
        });
        return tagged('CreatePullRequestPayload', { pullRequest: pullWrapper(repo, pull) });
      },
    },
    mergePullRequest: {
      type: 'MergePullRequestPayload',
      resolve: (_source, args) => {
        const input = (args.input ?? {}) as AnyRecord;
        const resolved = typeof input.pullRequestId === 'string' ? resolveGlobalId(input.pullRequestId) : null;
        if (resolved === null || resolved.kind !== 'PullRequest' || resolved.pull === undefined) throw new GqlError('Could not resolve the pull request id');
        mergePullRecord(resolved.repo, resolved.pull);
        return tagged('MergePullRequestPayload', { pullRequest: pullWrapper(resolved.repo, resolved.pull) });
      },
    },
    addComment: {
      type: 'AddCommentPayload',
      resolve: (_source, args) => {
        const input = (args.input ?? {}) as AnyRecord;
        const resolved = typeof input.subjectId === 'string' ? resolveGlobalId(input.subjectId) : null;
        if (resolved === null || resolved.kind !== 'Issue' || resolved.issue === undefined) throw new GqlError('Could not resolve the subject id');
        const comment = { id: store.newCommentId(), body: String(input.body ?? ''), seq: store.nextSeq() };
        resolved.issue.comments.push(comment);
        return tagged('AddCommentPayload', {
          commentEdge: tagged('AddCommentEdge', { node: commentWrapper(resolved.repo, resolved.issue, comment) }),
        });
      },
    },
  },
  User: {
    id: { type: 'ID', resolve: (source) => Buffer.from(`User:${String(source.login)}`, 'utf8').toString('base64url') },
    login: { type: 'String', resolve: (source) => String(source.login) },
    name: { type: 'String', resolve: (source) => (source.login === store.viewer.login ? store.viewer.name : String(source.login)) },
    email: { type: 'String', resolve: (source) => (source.login === store.viewer.login ? store.viewer.email : '') },
  },
  Repository: {
    id: { type: 'ID', resolve: (source) => encodeGlobalId('Repository', repoGlobalKey(source.repo as RepoRec)) },
    databaseId: { type: 'Int', resolve: (source) => (source.repo as RepoRec).id },
    name: { type: 'String', resolve: (source) => (source.repo as RepoRec).name },
    nameWithOwner: { type: 'String', resolve: (source) => repoGlobalKey(source.repo as RepoRec) },
    owner: { type: 'User', resolve: (source) => userWrapper((source.repo as RepoRec).owner) },
    isPrivate: { type: 'Boolean', resolve: (source) => (source.repo as RepoRec).isPrivate },
    description: { type: 'String', resolve: (source) => (source.repo as RepoRec).description },
    defaultBranchRef: {
      type: 'Ref',
      resolve: (source) => {
        const repo = source.repo as RepoRec;
        return repo.refs.has(`refs/heads/${repo.defaultBranch}`) ? tagged('Ref', { name: repo.defaultBranch }) : null;
      },
    },
    viewerPermission: { type: 'String', resolve: () => 'ADMIN' },
    hasIssuesEnabled: { type: 'Boolean', resolve: () => true },
    issue: {
      type: 'Issue',
      resolve: (source, args) => {
        const repo = source.repo as RepoRec;
        const issue = repo.issues.get(Number(args.number));
        return issue === undefined ? null : issueWrapper(repo, issue);
      },
    },
    issues: {
      type: 'IssueConnection',
      resolve: (source, args) => {
        const repo = source.repo as RepoRec;
        let list = [...repo.issues.values()];
        const states = Array.isArray(args.states) ? (args.states as unknown[]).map(String) : null;
        if (states !== null) list = list.filter((issue) => states.includes(issue.state.toUpperCase()));
        const orderBy = (args.orderBy ?? null) as AnyRecord | null;
        const direction = orderBy !== null && typeof orderBy.direction === 'string' ? orderBy.direction : 'ASC';
        list.sort((a, b) => (direction === 'DESC' ? b.seq - a.seq || b.number - a.number : a.seq - b.seq || a.number - b.number));
        const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : 30;
        let start = 0;
        const afterNumber = numberOfCursor(args.after);
        if (afterNumber !== null) {
          const index = list.findIndex((issue) => issue.number === afterNumber);
          if (index >= 0) start = index + 1;
        }
        const page = list.slice(start, start + first);
        return tagged('IssueConnection', {
          nodes: page.map((issue) => issueWrapper(repo, issue)),
          pageInfo: pageInfoWrapper(
            start + page.length < list.length,
            start > 0,
            page.length > 0 ? cursorOf((page[0] as IssueRec).number) : null,
            page.length > 0 ? cursorOf((page[page.length - 1] as IssueRec).number) : null,
          ),
          totalCount: list.length,
        });
      },
    },
    pullRequest: {
      type: 'PullRequest',
      resolve: (source, args) => {
        const repo = source.repo as RepoRec;
        const pull = repo.pulls.get(Number(args.number));
        return pull === undefined ? null : pullWrapper(repo, pull);
      },
    },
    pullRequests: {
      type: 'PullRequestConnection',
      resolve: (source, args) => {
        const repo = source.repo as RepoRec;
        const list = [...repo.pulls.values()].sort((a, b) => a.seq - b.seq);
        const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : 30;
        const page = list.slice(0, first);
        return tagged('PullRequestConnection', {
          nodes: page.map((pull) => pullWrapper(repo, pull)),
          pageInfo: pageInfoWrapper(page.length < list.length, false, null, null),
          totalCount: list.length,
        });
      },
    },
  },
  Ref: {
    name: { type: 'String', resolve: (source) => String(source.name) },
    prefix: { type: 'String', resolve: () => 'refs/heads/' },
  },
  Issue: {
    id: { type: 'ID', resolve: (source) => encodeGlobalId('Issue', issueGlobalKey(source.repo as RepoRec, source.issue as IssueRec)) },
    number: { type: 'Int', resolve: (source) => (source.issue as IssueRec).number },
    title: { type: 'String', resolve: (source) => (source.issue as IssueRec).title },
    state: { type: 'String', resolve: (source) => (source.issue as IssueRec).state.toUpperCase() },
    body: { type: 'String', resolve: (source) => (source.issue as IssueRec).body },
  },
  PullRequest: {
    id: { type: 'ID', resolve: (source) => encodeGlobalId('PullRequest', pullGlobalKey(source.repo as RepoRec, source.pull as PullRec)) },
    number: { type: 'Int', resolve: (source) => (source.pull as PullRec).number },
    title: { type: 'String', resolve: (source) => (source.pull as PullRec).title },
    body: { type: 'String', resolve: (source) => (source.pull as PullRec).body },
    state: {
      type: 'String',
      resolve: (source) => {
        const pull = source.pull as PullRec;
        return pull.merged ? 'MERGED' : pull.state.toUpperCase();
      },
    },
    merged: { type: 'Boolean', resolve: (source) => (source.pull as PullRec).merged },
    headRefName: { type: 'String', resolve: (source) => (source.pull as PullRec).headRef },
    baseRefName: { type: 'String', resolve: (source) => (source.pull as PullRec).baseRef },
    mergeable: {
      type: 'String',
      resolve: (source) => {
        const pull = source.pull as PullRec;
        if (pull.state !== 'open') return 'UNKNOWN';
        return pullMergeable(source.repo as RepoRec, pull) ? 'MERGEABLE' : 'CONFLICTING';
      },
    },
    files: {
      type: 'PullRequestChangedFileConnection',
      resolve: (source, args) => {
        const repo = source.repo as RepoRec;
        const pull = source.pull as PullRec;
        const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : 30;
        const changes = pullFiles(repo, pull).slice(0, first);
        return tagged('PullRequestChangedFileConnection', {
          nodes: changes.map((change) => tagged('PullRequestChangedFile', { path: change.path, additions: change.additions, deletions: change.deletions })),
          totalCount: changes.length,
        });
      },
    },
  },
  IssueComment: {
    id: {
      type: 'ID',
      resolve: (source) =>
        encodeGlobalId('IssueComment', commentGlobalKey(source.repo as RepoRec, source.issue as IssueRec, source.comment as { id: number; body: string; seq: number })),
    },
    body: { type: 'String', resolve: (source) => (source.comment as { body: string }).body },
  },
  IssueConnection: {
    nodes: { type: '[Issue]', resolve: (source) => source.nodes },
    pageInfo: { type: 'PageInfo', resolve: (source) => source.pageInfo },
    totalCount: { type: 'Int', resolve: (source) => source.totalCount },
  },
  PullRequestConnection: {
    nodes: { type: '[PullRequest]', resolve: (source) => source.nodes },
    pageInfo: { type: 'PageInfo', resolve: (source) => source.pageInfo },
    totalCount: { type: 'Int', resolve: (source) => source.totalCount },
  },
  PullRequestChangedFileConnection: {
    nodes: { type: '[PullRequestChangedFile]', resolve: (source) => source.nodes },
    totalCount: { type: 'Int', resolve: (source) => source.totalCount },
  },
  PullRequestChangedFile: {
    path: { type: 'String', resolve: (source) => String(source.path) },
    additions: { type: 'Int', resolve: (source) => Number(source.additions ?? 0) },
    deletions: { type: 'Int', resolve: (source) => Number(source.deletions ?? 0) },
  },
  PageInfo: {
    hasNextPage: { type: 'Boolean', resolve: (source) => source.hasNextPage === true },
    hasPreviousPage: { type: 'Boolean', resolve: (source) => source.hasPreviousPage === true },
    startCursor: { type: 'String', resolve: (source) => (source.startCursor as string | null) ?? null },
    endCursor: { type: 'String', resolve: (source) => (source.endCursor as string | null) ?? null },
  },
  CreateIssuePayload: { issue: { type: 'Issue', resolve: (source) => source.issue } },
  CloseIssuePayload: { issue: { type: 'Issue', resolve: (source) => source.issue } },
  CreatePullRequestPayload: { pullRequest: { type: 'PullRequest', resolve: (source) => source.pullRequest } },
  MergePullRequestPayload: { pullRequest: { type: 'PullRequest', resolve: (source) => source.pullRequest } },
  AddCommentPayload: { commentEdge: { type: 'AddCommentEdge', resolve: (source) => source.commentEdge } },
  AddCommentEdge: { node: { type: 'IssueComment', resolve: (source) => source.node } },
  __Type: {
    name: { type: 'String', resolve: (source) => String(source.name) },
    kind: { type: 'String', resolve: (source) => (source.info as { kind: string }).kind },
    description: { type: 'String', resolve: () => null },
    fields: {
      type: '[__Field]',
      resolve: (source) => {
        const info = source.info as { fields?: string[] };
        return (info.fields ?? []).map((name) => tagged('__Field', { name }));
      },
    },
    enumValues: {
      type: '[__EnumValue]',
      resolve: (source) => {
        const info = source.info as { enumValues?: string[] };
        return (info.enumValues ?? []).map((name) => tagged('__EnumValue', { name }));
      },
    },
  },
  __Field: { name: { type: 'String', resolve: (source) => String(source.name) } },
  __EnumValue: { name: { type: 'String', resolve: (source) => String(source.name) } },
};

// ---------------------------------------------------------------------------
// completion

interface CollectedField {
  node: FieldNode;
  responseKey: string;
}

function collectFields(ctx: ExecCtx, typeName: string, selections: readonly SelectionNode[], out: CollectedField[]): void {
  for (const selection of selections) {
    if (selection.kind === 'field') {
      out.push({ node: selection, responseKey: selection.alias ?? selection.name });
    } else if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition === null || selection.typeCondition === typeName) {
        collectFields(ctx, typeName, selection.selectionSet, out);
      }
    } else {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined && fragment.typeCondition === typeName) {
        collectFields(ctx, typeName, fragment.selectionSet, out);
      }
    }
  }
}

function completeValue(ctx: ExecCtx, type: string, value: unknown, selectionSet: SelectionNode[] | null): unknown {
  if (value === null || value === undefined) return null;
  if (isListType(type)) {
    const inner = type.trim().replace(/^\[/, '').replace(/\]$/, '');
    const items = Array.isArray(value) ? value : [value];
    return items.map((item) => completeValue(ctx, inner, item, selectionSet));
  }
  const named = namedTypeOf(type);
  if (SCALARS.has(named) || TYPE_INFO[named]?.kind === 'ENUM') return value;
  // An object type: apply the selection set.
  const record = value as AnyRecord;
  const effectiveType = typeof record.__type === 'string' ? record.__type : named;
  return executeSelectionSet(ctx, effectiveType, record, selectionSet ?? []);
}

function executeSelectionSet(ctx: ExecCtx, typeName: string, source: AnyRecord, selections: readonly SelectionNode[]): AnyRecord {
  const fields: CollectedField[] = [];
  collectFields(ctx, typeName, selections, fields);
  const out: AnyRecord = {};
  for (const { node, responseKey } of fields) {
    if (node.name === '__typename') {
      out[responseKey] = typeName;
      continue;
    }
    const def = SCHEMA[typeName]?.[node.name];
    if (def === undefined) {
      ctx.errors.push({ message: `Field '${node.name}' doesn't exist on type '${typeName}'` });
      out[responseKey] = null;
      continue;
    }
    const args: AnyRecord = {};
    for (const arg of node.args) args[arg.name] = valueOf(arg.value, ctx.variables);
    let value: unknown;
    try {
      value = def.resolve(source, args);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
      out[responseKey] = null;
      continue;
    }
    out[responseKey] = completeValue(ctx, def.type, value, node.selectionSet);
  }
  return out;
}

/** Execute one GraphQL operation body ({query, variables, operationName}). */
export function executeGraphQL(body: { query?: unknown; variables?: unknown; operationName?: unknown }): { data: unknown; errors?: { message: string }[] } {
  if (typeof body.query !== 'string') return { data: null, errors: [{ message: 'A query string is required' }] };
  let document: DocumentNode;
  try {
    document = parseGraphQL(body.query);
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Parse error' }] };
  }
  const variables = (typeof body.variables === 'object' && body.variables !== null ? body.variables : {}) as AnyRecord;
  let operation: OperationNode | undefined;
  if (typeof body.operationName === 'string') operation = document.operations.find((entry) => entry.name === body.operationName);
  operation ??= document.operations[0];
  if (operation === undefined) return { data: null, errors: [{ message: 'No operation in the document' }] };
  const ctx: ExecCtx = { variables, fragments: document.fragments, errors: [] };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelectionSet(ctx, rootType, tagged(rootType, {}), operation.selectionSet);
  return ctx.errors.length > 0 ? { data, errors: ctx.errors } : { data };
}
