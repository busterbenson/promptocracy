#!/usr/bin/env bash
# Create a game, tied to its own public GitHub repo, with a fresh random join
# code, and print the join link. The code is generated here, at setup time, and
# never committed (the repo is public). Usage:
#   scripts/create-game.sh --slug first --name "Game one" --repo owner/name [options]
# Options:
#   --rules-path PATH    rules file in that repo (default RULES.md)
#   --rules-ref REF      branch or tag (default main)
#   --max-players N      1-8, default 8: the game's max_players setting (at most 8 seats)
#   --size N             side of the starting island, even, 4-16 (default 8: an 8x8 island, 4W..4E by 4N..4S).
#                        Every other board setting is written to the game's row at its default (src/lib/settings.js).
#   --winning-score N    default 100
#   --local | --remote   which D1 (default --local; --remote is run by whoever deploys)
# Env: SITE_URL (for the printed link, default http://localhost:8788),
#      PROMPTOCRACY_PERSIST_TO (local state dir, used by the tests),
#      RULES_BASE_URL (read rules from here instead of raw.githubusercontent.com; tests).
set -euo pipefail
cd "$(dirname "$0")/.."

die() { echo "create-game: $*" >&2; exit 1; }
where="--local"; slug=""; name=""; repo=""; rpath="RULES.md"; ref="main"; max=8; win=100; size=8
while [ $# -gt 0 ]; do
  case "$1" in
    --slug) slug="${2:-}"; shift 2 ;;
    --name) name="${2:-}"; shift 2 ;;
    --repo) repo="${2:-}"; shift 2 ;;
    --rules-path) rpath="${2:-}"; shift 2 ;;
    --rules-ref) ref="${2:-}"; shift 2 ;;
    --max-players) max="${2:-}"; shift 2 ;;
    --winning-score) win="${2:-}"; shift 2 ;;
    --size) size="${2:-}"; shift 2 ;;
    --local) where="--local"; shift ;;
    --remote) where="--remote"; shift ;;
    *) die "unknown option: $1" ;;
  esac
done
[ -n "$slug" ] && [ -n "$name" ] && [ -n "$repo" ] || die "--slug, --name and --repo are required"

# Slug: 2-40 of a-z 0-9 -, starting and ending with a letter or digit, not a reserved word.
[[ "$slug" =~ ^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$ ]] || die "slug must be 2-40 characters of a-z, 0-9 and '-', starting and ending with a letter or digit"
case "$slug" in api|auth|join|assets|static|site.css|theme.css|index.html|admin|www|mail|help|about|rules|board|js|vendor) die "'$slug' is a reserved word, pick another slug" ;; esac
seg='[A-Za-z0-9._-]+'
[[ "$repo" =~ ^$seg/$seg$ ]] && [[ "$repo" != *..* ]] && [[ "$repo" != ./* ]] && [[ "$repo" != */. ]] || die "--repo must look like owner/name"
[[ "$rpath" =~ ^$seg(/$seg)*$ ]] && [[ "$rpath" != *..* ]] && [[ "/$rpath/" != */./* ]] || die "--rules-path must be a plain relative path with no '..'"
[[ "$ref" =~ ^$seg(/$seg)*$ ]] && [[ "$ref" != *..* ]] && [[ "/$ref/" != */./* ]] || die "--rules-ref must be a branch or tag name"
[[ "$max$win$size" =~ ^[0-9]+$ ]] || die "--max-players, --winning-score and --size must be numbers"
[ "$max" -ge 1 ] && [ "$max" -le 8 ] || die "--max-players must be 1 to 8 (a game seats at most 8)"
[ "$size" -ge 4 ] && [ "$size" -le 16 ] && [ $((size % 2)) -eq 0 ] || die "--size must be an even number from 4 to 16"
[ "${#name}" -le 80 ] || die "--name is too long"

# The rules must be publicly readable, because the site fetches them without a token.
base="${RULES_BASE_URL:-https://raw.githubusercontent.com}"
url="${base%/}/$repo/$ref/$rpath"
status="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 "$url" || true)"
[ "$status" = "200" ] || die "cannot read $url (HTTP ${status:-none}). The game's repo must be public and contain $rpath on $ref."

site="${SITE_URL:-http://localhost:8788}"
# 8 characters, no 0/O/1/I/L lookalikes: about 40 bits.
# (|| true: head closing the pipe makes tr exit 141 under pipefail.)
code="$(LC_ALL=C tr -dc 'A-HJKMNP-Z2-9' </dev/urandom | head -c 8 || true)"
[ "${#code}" -eq 8 ] || die "could not generate a code"
id="$(uuidgen | tr 'A-Z' 'a-z')"
sqlname="${name//\'/\'\'}"
settings="$(node scripts/default-settings.mjs "$size" "$max")" || die "could not build the default settings"
persist=()
[ -n "${PROMPTOCRACY_PERSIST_TO:-}" ] && persist=(--persist-to "$PROMPTOCRACY_PERSIST_TO")

insert="INSERT INTO games (id, slug, name, repo, rules_path, rules_ref, join_code, status, winning_score, settings, created_at)
   VALUES ('$id', '$slug', '$sqlname', '$repo', '$rpath', '$ref', '$code', 'setup', $win, '${settings//\'/\'\'}', strftime('%Y-%m-%dT%H:%M:%fZ','now'));"
if [ "$where" = "--local" ] && [ -n "${PROMPTOCRACY_PERSIST_TO:-}" ]; then
  # The tests' state dir: run the insert in-process on the same local D1 file (scripts/local-d1.mjs), not through a ~1 s wrangler spawn.
  out="$(node scripts/local-d1.mjs "$PROMPTOCRACY_PERSIST_TO" "$insert" 2>&1)"
else
  out="$(npx wrangler d1 execute DB "$where" ${persist[@]+"${persist[@]}"} --command "$insert" 2>&1)"
fi || {
  if [[ "$out" == *UNIQUE* ]]; then die "a game with slug '$slug' already exists"; fi
  echo "$out" >&2; die "could not insert the game (has the schema been applied? npm run migrate:local)"
}

# The starting island is charted the first time anything needs the board (a join, a read).

echo "Game: $name  (/$slug/, rules from $repo)"
echo "Board: $size x $size starting island, charted on first use"
echo "Join code: $code"
echo "Join link: ${site%/}/$slug/join/$code"
