#!/usr/bin/env bash
# Netlify "ignore" command (see [build] ignore in netlify.toml).
#   exit 0 -> skip this build (nothing that affects the deployed app changed)
#   exit 1 -> build
#
# Builds cost credits, so changes that can't alter the deployed app (docs, tests,
# CI config, PR descriptions) don't trigger one. When in doubt this builds.
#
# Keep APP_PATHS in sync with what ships: runtime code, agent instructions and
# skills (AGENTS.md and .agents are read by the deployed agent), dependencies,
# and build configuration.

set -u

APP_PATHS=(
  app
  server
  actions
  scripts
  public
  .agents
  AGENTS.md
  learnings.md
  learnings.defaults.md
  package.json
  pnpm-lock.yaml
  pnpm-workspace.yaml
  netlify.toml
  vite.config.ts
  react-router.config.ts
  ssr-entry.ts
  tsconfig.json
  components.json
  agent-native.config.ts
  agent-native.json
)

# Test files never ship.
EXCLUDES=(
  ':(exclude,glob)**/*.test.ts'
  ':(exclude,glob)**/*.test.tsx'
  ':(exclude,glob)**/__tests__/**'
)

# No previous build to compare with (first build, cache miss): build.
if [ -z "${CACHED_COMMIT_REF:-}" ] || [ -z "${COMMIT_REF:-}" ]; then
  echo "No previous build to compare against; building."
  exit 1
fi

# The previous commit isn't available (shallow clone, rewritten history): build.
if ! git cat-file -e "${CACHED_COMMIT_REF}^{commit}" 2>/dev/null; then
  echo "Previous build commit ${CACHED_COMMIT_REF} not found; building."
  exit 1
fi

git diff --quiet "$CACHED_COMMIT_REF" "$COMMIT_REF" -- "${APP_PATHS[@]}" "${EXCLUDES[@]}"
status=$?

if [ "$status" -eq 0 ]; then
  echo "No app changes since ${CACHED_COMMIT_REF}; skipping build."
  exit 0
fi

# 1 means there are differences; anything else is a git error. Build either way.
echo "App changes since ${CACHED_COMMIT_REF} (or git error ${status}); building."
exit 1
