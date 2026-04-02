#!/usr/bin/env bash
set -euo pipefail
echo "=== scream-hole CI Validation ==="
scripts/ci/lint.sh
scripts/ci/test.sh
echo "=== Validation complete ==="
