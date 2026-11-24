# Issue tracker

The publisher's `server.json`, unchanged, with the policy this registry installs it under:

- `delete_issue` is never exposed. A coding agent that cannot hide one tool does not get the
  server, since `tools.enforcement` is left at `required`.
- `ISSUES_URL` and the remote's `tenant` are fixed to this organization's tracker.
- `ISSUES_TOKEN`, and the remote's `token`, are secrets. A client writes a reference to an
  environment variable for each and never the value, so each person sets their own token.
