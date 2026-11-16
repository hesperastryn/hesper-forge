# Build log — hesper-forge

A GitHub-compatible git forge written from scratch for make.fun's
github-core-clone-01 bounty, in one Node.js process with no dependencies.

## Design

- `store.ts` — the in-memory data model: repositories with their own git
  object databases, refs, labels, issues, pull requests and comments, plus
  the Relay-style global ids the GraphQL surface round-trips. One store for
  every surface, so an object created over REST is the same object over
  GraphQL, MCP and git. Timestamps come from a logical clock so runs are
  reproducible.
- `gitcore.ts` — git plumbing by hand: pkt-lines, SHA-1 object identity,
  packfiles (reading with ofs/ref delta resolution, writing full objects),
  trees, commits, reachability with shallow-depth limits, ancestry and
  merge bases, three-way tree merges and LCS line diffs.
- `githttp.ts` — smart HTTP: protocol v2 capability advertisement and
  ls-refs/fetch, the v0 fetch fallback, and v0 receive-pack with
  report-status over side-band-64k and per-ref fast-forward enforcement.
- `rest.ts` — the REST v3 surface: repositories, branches, refs, commits,
  contents (create/update/delete with sha checks), labels, issues,
  comments, pull requests with files and squash merges.
- `graphql.ts` — a small GraphQL lexer/parser/executor covering the
  documents gh and github-mcp-server send: viewer, repository fields,
  introspection, issue/pull-request reads, cursor pagination, batched
  operations and the create/close/merge/comment mutations.
- `mcp.ts` — JSON-RPC 2.0 over streamable HTTP speaking both MCP eras
  (server/discover at 2026-07-28 and the initialize handshake), with eight
  tools over the same store.
- `ops.ts` — the domain operations (contents commits, issue/pull creation,
  squash merges) shared by the three API surfaces.
- `main.ts` / `app.ts` — the harness lifecycle and the HTTP server.

## Verification

- The kit's local suite (sdk/run.ts): 120/120 conformance checks pass
  (git 30, repos 15, issues 15, pulls 20, graphql 20, mcp 15, protocol 5),
  and the MCP group doubles as the agent column at 15/15.
- The four benchmark workloads (push / clone / read / write) all measure;
  scores hover at or above the calibrated reference medians.
- Verified on Node 22.18 (the grader's runtime) as well as Node 24.
