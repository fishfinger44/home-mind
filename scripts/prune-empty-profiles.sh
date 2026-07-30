#!/usr/bin/env bash
#
# Delete memory profiles that hold no facts.
#
# Every experiment, integration test and curl against the API creates a profile
# in the memory store and leaves it there: a household with two people ended up
# with twenty-nine. They are individually tiny, but they clutter the user list
# and make it hard to see at a glance whose memory is whose.
#
# A profile is removed only when it has ZERO facts, so this cannot take a real
# person's memory. Prints what it would do and changes nothing unless --apply
# is passed.
#
#   ./scripts/prune-empty-profiles.sh            # dry run
#   ./scripts/prune-empty-profiles.sh --apply
#   KEEP="default guest" ./scripts/prune-empty-profiles.sh --apply
#
set -euo pipefail

APPLY=false
[[ "${1:-}" == "--apply" ]] && APPLY=true

cd "$(dirname "$0")/.."
[[ -f .env ]] && source .env

SHODH="${SHODH_URL:-http://127.0.0.1:3030}"
SERVER="${HOME_MIND_URL:-http://127.0.0.1:3100}"
# The shared profile answers for anyone we cannot identify, so it stays even
# while empty — it is where guests and automations are meant to land.
KEEP="${KEEP:-default}"

if [[ -z "${SHODH_API_KEY:-}" ]]; then
  echo "SHODH_API_KEY is not set (expected in .env or the environment)" >&2
  exit 1
fi

users=$(curl -fsS -H "Authorization: Bearer $SHODH_API_KEY" "$SHODH/api/users" |
  python3 -c "import json,sys; print(' '.join(json.load(sys.stdin)))")

removed=0
kept=0
for user in $users; do
  if [[ " $KEEP " == *" $user "* ]]; then
    echo "keep    $user (protected)"
    kept=$((kept + 1))
    continue
  fi

  facts=$(curl -fsS "$SERVER/api/memory/$user" | python3 -c "
import json, sys
data = json.load(sys.stdin)
print(len(data if isinstance(data, list) else data.get('facts', [])))
")

  if [[ "$facts" -gt 0 ]]; then
    echo "keep    $user ($facts facts)"
    kept=$((kept + 1))
    continue
  fi

  if $APPLY; then
    curl -fsS -X DELETE -H "Authorization: Bearer $SHODH_API_KEY" \
      "$SHODH/api/users/$user" >/dev/null
    echo "removed $user"
  else
    echo "would remove $user (no facts)"
  fi
  removed=$((removed + 1))
done

echo
if $APPLY; then
  echo "Removed $removed empty profiles, kept $kept."
else
  echo "$removed empty profiles would be removed, $kept kept. Re-run with --apply."
fi
