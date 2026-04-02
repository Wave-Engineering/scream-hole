#!/usr/bin/env bash
# Run bun unit tests.
set -euo pipefail

echo "--- Installing dependencies ---"
bun install --frozen-lockfile

echo "--- Running tests ---"
bun test
