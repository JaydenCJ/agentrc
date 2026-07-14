#!/usr/bin/env bash
# Example PreToolUse hook: block obviously destructive shell commands.
input="$(cat)"
if echo "$input" | grep -Eq 'rm -rf /($| )'; then
  echo '{"decision": "block", "reason": "refusing to run rm -rf /"}'
  exit 0
fi
exit 0
