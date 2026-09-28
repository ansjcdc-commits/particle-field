#!/bin/zsh
set -u

PROJECT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
SERVER_LOG="/tmp/particle-field-local-server.log"
PORT=""

# Reuse this project's server if it is already running on its fixed address.
PORT=8000
if ! /usr/bin/curl -fsS --max-time 1 "http://127.0.0.1:${PORT}/" 2>/dev/null | /usr/bin/grep -q 'Particle Field — Hand Interaction'; then
  if /usr/sbin/lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port 8000 is being used by another app. Close that app and run this launcher again."
    read "?Press Return to close..."
    exit 1
  fi
  cd "$PROJECT_DIR"
  nohup python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$PROJECT_DIR" >"$SERVER_LOG" 2>&1 </dev/null &
  for attempt in {1..40}; do
    if /usr/bin/curl -fsS --max-time 1 "http://127.0.0.1:${PORT}/" 2>/dev/null | /usr/bin/grep -q 'Particle Field — Hand Interaction'; then break; fi
    sleep 0.25
  done
fi

URL="http://localhost:${PORT}/"
if ! /usr/bin/curl -fsS --max-time 2 "$URL" 2>/dev/null | /usr/bin/grep -q 'Particle Field — Hand Interaction'; then
  echo "Could not start the local site. Check that Python 3 is installed."
  echo "Server log: $SERVER_LOG"
  read "?Press Return to close..."
  exit 1
fi

echo "Particle Field is ready at $URL"
open "$URL"
