---
name: gh-oauth-login
description: >-
  Use when logging the GitHub CLI (gh) in or adding a gh account through a
  browser OAuth redirect (state + PKCE, all scopes) instead of the device-code
  flow.
---
# gh OAuth login (browser redirect, no device code)

One dependency-free Node 20+ script, `scripts/gh-oauth-login.mjs` (next to this file). It starts a temporary server on 127.0.0.1, opens GitHub's authorize page as the gh CLI OAuth app with state and PKCE, requests **all scopes** by default, exchanges the code, pipes the token straight into `gh auth login --with-token`, then runs `gh auth status`. The token is never written to a file, logged, or printed.

## Run

```bash
node scripts/gh-oauth-login.mjs                 # opens the browser, all scopes
node scripts/gh-oauth-login.mjs --print-url     # print the link to open elsewhere
```

Options:
- `--host <host>` GitHub host (default `github.com`).
- `--scopes "<list>"` space or comma separated; default is every scope (repo workflow write:packages delete:packages admin:org admin:public_key admin:repo_hook admin:org_hook gist notifications user delete_repo write:discussion admin:enterprise audit_log codespace project admin:gpg_key admin:ssh_signing_key copilot).
- `--port <n>` fixed callback port (default random free port).
- `--print-url` don't open a browser. The final redirect goes to `http://127.0.0.1:<port>/callback`, so on another device either forward that port to this machine (e.g. `ssh -L <port>:127.0.0.1:<port> host` with `--port` fixed) or, after approving, copy the failed `127.0.0.1` callback URL from the other device and `curl` it on this machine.
- `--switch` make the new account active (default: keep the previously active account active).
- `--replace` allow refreshing an account gh already has (default: stop with exit 3 and discard the token).
- `--timeout <min>` default 10.

## Steps
1. Run the script in the background with a fixed `--port` if the user approves on another device; relay only the authorize URL (it has no secrets, just state and PKCE challenge).
2. The user approves on GitHub themselves. Never fill the GitHub page for them unless asked.
3. When the script exits 0, report the login and granted scopes it printed. Exit 3 means the account already exists; ask before re-running with `--replace`.
4. If the machine has a post-login hook (for example an owner-to-account map sync), run it after a new account is added.

## Rules
- Don't log out or replace existing gh accounts without asking; adding one is fine.
- Never echo the token or put it in files; the script strips `GH_TOKEN`/`GITHUB_TOKEN` from gh's env so the stored login is used.
- The client ID/secret are the gh CLI's public OAuth app values (override with `GH_OAUTH_CLIENT_ID` / `GH_OAUTH_CLIENT_SECRET`).
