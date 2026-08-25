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

npm install
