---
name: pr-triage
description: Sort open pull requests by risk and staleness, link each to its tracker issue, and say which need a reviewer today.
---

# PR triage

1. List the open pull requests with the `tracker` server's `list_pull_requests` tool.
2. For each, find its tracker issue and note its priority.
3. Rank by priority, then by days since the last review.
4. Say which three need a reviewer today, and why.
