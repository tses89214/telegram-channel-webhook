#!/bin/bash
# .mcp.json execs this with a per-bot env file, so secrets stay out of any tracked file.
set -euo pipefail
ENV_FILE="${1:?usage: run.sh <path-to-bot-env-file>}"
set -a; source "$ENV_FILE"; set +a
exec bun run "$(dirname "$(readlink -f "$0")")/webhook.ts"
