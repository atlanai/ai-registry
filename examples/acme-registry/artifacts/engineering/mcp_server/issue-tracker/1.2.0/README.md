# Issue tracker

The publisher's `server.json`, unchanged. It declares a package and a remote:

- `ISSUES_URL` and the remote's `tenant` are inputs the person installing fills in.
- `ISSUES_TOKEN`, and the remote's `token`, are secrets. A client writes a reference to an
  environment variable for each and never the value, so each person sets their own token.
