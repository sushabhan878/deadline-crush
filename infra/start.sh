#!/bin/sh
set -eu
npm run migrate
if [ "${BOOTSTRAP_DEMO:-0}" = 1 ]; then npm run seed; fi
if [ -n "${EVENT_JOIN_CODE:-}" ]; then node --import tsx scripts/bootstrap.ts; fi
node --import tsx apps/worker/src/main.ts &
exec node --import tsx apps/api/src/main.ts
