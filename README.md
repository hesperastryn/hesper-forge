# hesper-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/hesperastryn/hesper-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/hesperastryn/hesper-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single dependency-free Node.js process. It serves the GitHub REST v3 API (repositories, branches, commits, contents, labels, issues, comments, pull requests with squash merges), the GraphQL v4 documents that `gh` and github-mcp-server send (including introspection, cursor pagination and batched operations), an MCP endpoint speaking both the 2026-07-28 `server/discover` revision and the legacy initialize handshake, and git smart HTTP — protocol v2 ls-refs/fetch with shallow support plus v0 receive-pack with report-status — with the git object model, packfiles, three-way merges and line diffs all implemented by hand on `node:crypto` and `node:zlib`. One in-memory store backs every surface, so an object created through one is the same object through all the others.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=9sbzt2n6&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
