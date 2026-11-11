#!/usr/bin/env bash
# Starts the dev server in the background and waits until it answers.
# Used by CI; the server keeps running for the following steps of the job.
set -euo pipefail

url="http://localhost:5173/"
log="${RUNNER_TEMP:-/tmp}/dev-server.log"

pnpm --filter web dev >"$log" 2>&1 &

for _ in $(seq 1 60); do
	if curl -fs -o /dev/null "$url"; then
		echo "dev server is up: $url"
		exit 0
	fi
	sleep 1
done

echo "dev server did not answer within 60 seconds" >&2
cat "$log" >&2
exit 1
