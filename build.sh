#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

if [[ -f "$SCRIPT_DIR/.env" ]]; then
    source "$SCRIPT_DIR/.env"
elif [[ -f "$SCRIPT_DIR/.dev.vars" ]]; then
    source "$SCRIPT_DIR/.dev.vars"
fi

CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/ciao-repo"
BUILD_DIR="$SCRIPT_DIR/.ciao-repo"
REPO_URL="https://github.com/PrimalDjinn/openbao.git"
REPO_BRANCH="${REPO_BRANCH:-main}"

# Clone or update the cached copy (keeps .git for fast incremental updates)
if [[ -d "$CACHE_DIR/.git" ]]; then
    echo "Updating cached repo at $CACHE_DIR"
    git -C "$CACHE_DIR" fetch --depth 1 origin "$REPO_BRANCH"
    git -C "$CACHE_DIR" reset --hard "origin/$REPO_BRANCH"
else
    echo "Cloning repo to cache at $CACHE_DIR"
    git clone --depth 1 --branch "$REPO_BRANCH" "$REPO_URL" "$CACHE_DIR"
fi

# Copy a clean snapshot into the build context
rm -rf "$BUILD_DIR"
cp -r "$CACHE_DIR" "$BUILD_DIR"
# Sanitize git remote to remove the token, but keep .git for make bin
if [[ -d "$BUILD_DIR/.git" ]]; then
    git -C "$BUILD_DIR" remote set-url origin https://github.com/PrimalDjinn/openbao.git
fi

DOCKER_BUILDKIT=1 docker build -t ciao-local .
pnpm wrangler containers build . -t ciao-local
