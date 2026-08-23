#!/usr/bin/env bash
# Container entrypoint. Exists to bridge two constraints that collide the
# moment this app leaves a bare-metal / same-host deployment:
#
# 1. packages/facilitator/src/serve.ts hardcodes `hostname: '127.0.0.1'`
#    (not env-configurable) — deliberately, per its own comment: it holds
#    Razorpay secrets and mints ceremony tokens, and must never be directly
#    reachable except through a trusted reverse proxy or from the same host.
# 2. apps/store/src/server.ts does the same, and serve.ts's own
#    DEMO_STORE_URL ('http://127.0.0.1:8791') assumes the demo store is
#    reachable on that same loopback — i.e. the same network namespace.
#
# In a container, "the same host" only holds if every process that needs to
# see 127.0.0.1 runs inside this one container. So: the demo store and the
# facilitator both run here, and the only process bound to a
# container-external interface (0.0.0.0) is socat, relaying to the
# facilitator's loopback socket. This preserves the facilitator's own
# "never bind 0.0.0.0" invariant even though the container as a whole is
# reachable from the internet once published.
set -euo pipefail

PORT="${PORT:-8790}"
PUBLIC_PORT="${PUBLIC_PORT:-8080}"

cleanup() {
  jobs -p | xargs -r kill -TERM 2>/dev/null || true
}
trap cleanup TERM INT

# Fire-and-forget, matching serve.ts's own tolerance for a slow/absent demo
# store (it seeds the store's catalog without awaiting or retrying). Set
# ENABLE_DEMO_STORE=false when the store is run as a separate process/
# container sharing this one's network namespace (see docker-compose.yml's
# `store` service, network_mode: service:facilitator) — starting it twice
# would fight over port 8791.
if [ "${ENABLE_DEMO_STORE:-true}" = "true" ]; then
  echo "[entrypoint] starting demo store on 127.0.0.1:8791"
  (cd /app/apps/store && exec npx tsx src/server.ts) &
fi

echo "[entrypoint] starting facilitator on 127.0.0.1:${PORT}"
(cd /app/packages/facilitator && exec npx tsx src/serve.ts) &
FACILITATOR_PID=$!

# socat must not start forwarding before serve.ts has bound its port, or
# early connections (e.g. a platform health check) see connection-refused
# instead of a slow-but-correct response.
echo "[entrypoint] waiting for facilitator to bind :${PORT}"
for _ in $(seq 1 60); do
  if (exec 3<>"/dev/tcp/127.0.0.1/${PORT}") 2>/dev/null; then
    exec 3>&- 3<&-
    break
  fi
  sleep 1
done

echo "[entrypoint] starting public proxy 0.0.0.0:${PUBLIC_PORT} -> 127.0.0.1:${PORT}"
socat TCP-LISTEN:"${PUBLIC_PORT}",fork,reuseaddr TCP:127.0.0.1:"${PORT}" &
SOCAT_PID=$!

# Either process dying is fatal for the container — a facilitator crash
# should recycle the container (platform restart policy), and a dead proxy
# means the app is silently unreachable from outside even though the
# facilitator itself looks healthy from inside. `wait -n` exits as soon as
# either does.
wait -n "$FACILITATOR_PID" "$SOCAT_PID"
EXIT_CODE=$?
echo "[entrypoint] a supervised process exited (code ${EXIT_CODE}) — shutting down"
cleanup
exit "$EXIT_CODE"
