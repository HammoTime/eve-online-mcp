#!/usr/bin/env bash
set -euo pipefail

# Keep issue ownership explicit even when this script is run outside a checkout.
repository="HammoTime/eve-online-mcp"
title="ESI OpenAPI schema update required"
: "${GH_TOKEN:?GH_TOKEN is required}"
: "${ISSUE_BODY:?ISSUE_BODY is required}"

# Read every page directly: search indexing delays must not create duplicates.
# A failed lookup aborts before any issue can be created.
issue_numbers="$(gh api --paginate \
  "repos/${repository}/issues?state=open&per_page=100&sort=created&direction=asc" \
  --jq '.[] | select(.pull_request == null and .title == "ESI OpenAPI schema update required") | .number')"
issue_number="${issue_numbers%%$'\n'*}"

body_file="$(mktemp)"
trap 'rm -f -- "$body_file"' EXIT
printf '%s' "$ISSUE_BODY" > "$body_file"

if [ -z "$issue_number" ]; then
  gh issue create --repo "$repository" --title "$title" --body-file "$body_file"
else
  current_body="$(gh issue view "$issue_number" --repo "$repository" --json body --jq .body)"
  if [ "$current_body" = "$ISSUE_BODY" ]; then
    echo "Schema issue #${issue_number} already describes this change."
  else
    gh issue edit "$issue_number" --repo "$repository" --body-file "$body_file"
  fi
fi
