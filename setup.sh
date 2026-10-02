#!/usr/bin/env bash
set -e

# Change directory to project root
cd "$(dirname "$0")"

# Execute setup script
node scripts/setup.mjs "$@"
