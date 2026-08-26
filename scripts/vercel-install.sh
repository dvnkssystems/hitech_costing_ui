#!/usr/bin/env bash
set -euo pipefail

if [ -z "${GITHUB_TOKEN:-}" ]; then
  echo "GITHUB_TOKEN is required to install private GitHub dependencies." >&2
  exit 1
fi

token_url="https://x-access-token:${GITHUB_TOKEN}@github.com/"

git config --global url."${token_url}".insteadOf "https://github.com/"
git config --global --add url."${token_url}".insteadOf "git+ssh://git@github.com/"
git config --global --add url."${token_url}".insteadOf "ssh://git@github.com/"
git config --global --add url."${token_url}".insteadOf "git@github.com:"

# There's no lockfile (git-ref-pinned deps must always resolve fresh), but
# Vercel restores node_modules from its build cache on every deploy. Without a
# lockfile, npm's "up to date" fast path trusts that cached copy even when the
# git ref in package.json changed — a version bump silently deploys the old
# code. Wipe this package so npm has no choice but to re-resolve the ref.
rm -rf node_modules/@frappe-vue-sdk node_modules/.package-lock.json

npm install
