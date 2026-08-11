#!/usr/bin/env bash
#
# Copy the house configuration that lives outside this repo into it.
#
# Three of the files that decide how this house behaves are not version
# controlled anywhere: the Home Assistant scripts and automations sit on the
# HAOS virtual machine, and the house rules the assistant obeys live inside a
# Docker volume. On one ordinary day `scripts.yaml` changed five times; the
# only trace of each change was a `.bak_<timestamp>` copy beside it. That is a
# safety net for a single accident, not a history: it does not say what changed
# or why, and by the sixth copy the filenames stop meaning anything.
#
# So: pull them in, commit them like code, and let `git diff` answer the
# question "what did we change and what for".
#
# ONE DIRECTION ONLY — from the running system into the repo. Restoring is a
# deliberate act with a stopped service and a look at what is being overwritten,
# not something a sync script should do while nobody is watching.
#
#   ./scripts/sync-ha-config.sh          # copy, then show what changed
#
# Run it after editing anything on the HAOS side, the same way the HA
# integration copy under src/ha-integration has to be kept in step.

set -euo pipefail

HA_HOST="${HA_HOST:-root@192.168.88.227}"
HA_KEY="${HA_KEY:-$HOME/.ssh/ha_ed25519}"
# The rules are written by the server, so they live in its data volume rather
# than on the HA machine.
RULES_VOLUME="${RULES_VOLUME:-home-mind_conversation_data}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$REPO_ROOT/src/ha-config"
mkdir -p "$DEST"

pull_from_ha() {
  local name="$1"
  echo "  /config/$name"
  ssh -i "$HA_KEY" -o StrictHostKeyChecking=no "$HA_HOST" "cat /config/$name" > "$DEST/$name"
}

pull_from_volume() {
  local name="$1"
  echo "  volume:$RULES_VOLUME/$name"
  # A throwaway container is the only way in: the volume belongs to the server,
  # which does not run a shell we can rely on.
  docker run --rm -v "$RULES_VOLUME":/data alpine cat "/data/$name" > "$DEST/$name"
}

echo "Pulling house configuration into src/ha-config/"
pull_from_ha "scripts.yaml"
pull_from_ha "automations.yaml"
pull_from_volume "rules.json"
pull_from_volume "ograniczenia.json"

echo
echo "Changed since the last commit:"
# `git diff` alone would report nothing on the very first run, when the files
# are untracked — the one run where "nothing changed" is most misleading.
zmiany="$(git -C "$REPO_ROOT" status --porcelain -- src/ha-config)"
if [ -z "$zmiany" ]; then
  echo "  nothing — the repo already matched the running system"
else
  echo "$zmiany" | sed 's/^/  /'
  echo
  echo "Review with:  git diff -- src/ha-config     (add -- --cached once staged)"
fi
