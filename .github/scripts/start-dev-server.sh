#!/usr/bin/env bash
# Starts the dev server in the background and waits until it answers.
# Used by CI; the server keeps running for the following steps of the job.
set -euo pipefail

url="http://localhost:5173/"
log="${RUNNER_TEMP:-/tmp}/dev-server.log"

pnpm --filter web dev >"$log" 2>&1 &

# Give up after this many seconds in total. One probe may take at most 5: a
# server that accepts the connection but never answers must not hang the job.
deadline=60

while (( SECONDS < deadline )); do
	if curl -fs --max-time 5 -o /dev/null "$url"; then
		echo "dev server is up: $url"
		exit 0
	fi
	sleep 1
done

echo "dev server did not answer within $deadline seconds" >&2
cat "$log" >&2
exit 1
