# Containerized facilitator — spike

Prove-or-pivot spike: can the facilitator (Node 24 + Hono + better-sqlite3
native + Playwright chromium, `packages/facilitator`) run in a single Docker
container, well enough to deploy a public judge-facing instance to
Fly.io/Railway/a VPS?

**Scope:** everything under `deploy/` plus `.dockerignore` at the repo root.
No application code was touched.

## What's here

- `Dockerfile` — single-stage image on `mcr.microsoft.com/playwright:v1.62.1-noble`
  (matches the `playwright@1.62.1` version pnpm-lock.yaml resolves — see the
  comment at the top of the file for why the tag must track that exactly).
  Installs pnpm via corepack, installs the whole workspace
  (`pnpm install --frozen-lockfile`), builds `@hundi/core` and `@hundi/cli`
  (the facilitator imports `@hundi/core` by bare specifier, which resolves
  through its compiled `dist/`), and runs everything through `entrypoint.sh`.
- `entrypoint.sh` — process supervisor for the container. Read the comment
  block at its top first; it explains a real architectural constraint this
  spike surfaced (see **Finding: the facilitator cannot be exposed directly**
  below) and how the container works around it without touching app code.
- `docker-compose.yml` — one facilitator container, self-contained (demo
  store runs inside it as a second process, per `entrypoint.sh`). This is
  the shape a judge-facing deploy actually wants — see the file's header
  comment for why it's deliberately *not* split into two Compose services.
- `.env.example` — required/optional env vars, documented; copy to
  `deploy/.env` (gitignored — verified with `git check-ignore -v deploy/.env`)
  and fill in real values. **Never** committed, **never** baked into the
  image — passed at container start only.

## Finding: the facilitator cannot be exposed directly

`packages/facilitator/src/serve.ts` hardcodes `hostname: '127.0.0.1'` — not
env-configurable — by design: it holds Razorpay secrets and mints ceremony
tokens, and the code comment there says it "must never be reachable except
through a trusted reverse proxy or from the same host." `apps/store/src/server.ts`
does the same, and `serve.ts`'s own `DEMO_STORE_URL` constant
(`http://127.0.0.1:8791`) assumes the demo store lives on that same loopback.

That assumption is silently true on bare metal (both processes really do
share one host) and silently **false** the moment you put the facilitator in
a container and try to reach it from outside: nothing in the container is
listening on the container's externally-reachable interface, so a platform's
edge proxy (Fly.io, Railway) gets connection-refused forwarding traffic in.

This spike's fix, entirely inside `deploy/` and without touching `serve.ts`:
run the facilitator *and* the demo store as two processes in the same
container (so `127.0.0.1:8791` still resolves for both, exactly as the code
assumes), and add `socat` as a third process that's the *only* thing bound to
`0.0.0.0` — a public port (`PUBLIC_PORT`, default `8080`) forwarding to the
facilitator's real loopback socket (`PORT`, default `8790`). The facilitator's
own "never bind 0.0.0.0" invariant holds even though the container as a whole
is now internet-reachable.

This is a **designed, not yet end-to-end verified** fix — see the verdict
below for why, and what to check on first real deploy.

The durable follow-up (outside this spike's scope, since it's app code) is a
one-line change: read the bind host from an env var defaulting to
`127.0.0.1`, so a real reverse-proxy deploy can still keep the safe default
while a containerized one can opt into `0.0.0.0` explicitly and drop the
socat sidecar.

## Build & run

```bash
# from the repo root
docker build -f deploy/Dockerfile -t hundi-facilitator .

cp deploy/.env.example deploy/.env
# fill in RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET / RAZORPAY_WEBHOOK_SECRET /
# DASHBOARD_TOKEN / ADMIN_TOKEN in deploy/.env

docker run --rm -p 8080:8080 \
  --env-file deploy/.env \
  -v hundi-data:/data \
  --name hundi-facilitator \
  hundi-facilitator
```

Or via compose (equivalent, plus a named volume and restart policy):

```bash
docker compose -f deploy/docker-compose.yml up --build
```

### Verify it's up

```bash
curl -sS http://localhost:8080/stores | jq .
```

### Verify the live capture rail (the actual point of this spike)

The repo already ships an in-process live-integration test that drives the
*real* executor end to end — real checkout driver, real headless chromium,
real Razorpay TEST-mode API calls — and confirms capture independently via
`GET /orders/:id/payments`. This is the same script that produced the
`pay_TTBO5gj6lma2uw` capture referenced in the root README and
`WHAT-BROKE.md`, run here inside the container instead of on bare metal:

```bash
docker exec -it hundi-facilitator sh -c \
  "cd packages/facilitator && npx tsx bin/smoke-settle.ts"
```

(Note: **not** `pnpm smoke:settle` — that script wraps the command with
`tsx --env-file=../../.env`, and `.env` deliberately does not exist inside
the image. Env vars are already in `process.env` via `--env-file`/
`env_file` at container start, which is all `loadEnv()` needs.)

Expected final line on success: `smoke: OK — settlement <id> captured,
payment <id>`.

`packages/facilitator/src/rails/checkout-driver.ts` navigates chromium to
`http://localhost:${server.port}/...` — the checkout host page it starts
itself, same-process. That holds regardless of Docker: Playwright and the
page it's driving are both inside the one container, so this part of the
rail was never at risk from containerization. Confirmed by reading the
source, not by a container-network trace — see the verdict for what's
verified vs. reasoned-through.

## Deployment notes

**Outbound:** the container needs outbound HTTPS to Razorpay's API and to
`checkout.razorpay.com` (loaded inside the headless page) — standard on
every platform below, no extra config.

**Inbound / public port:** point the platform at `PUBLIC_PORT` (default
`8080`), not `PORT` (`8790`, loopback-only, never published) — see the
finding above.

**Webhooks:** `RAZORPAY_WEBHOOK_SECRET` verifies inbound webhook signatures,
but the webhook URL itself must be registered in the Razorpay dashboard
*after* the platform assigns a public URL — there's no way around a
deploy-then-register-then-redeploy(-if-needed) loop for that piece.

**DB persistence:** `DB_PATH=/data/hundi.db` must live on a platform volume
(Fly.io Volumes, Railway Volumes) or the ledger — the audit trail this whole
project's trust model rests on — resets on every restart/redeploy. Do not
run this on ephemeral-filesystem-only tiers.

**Memory:** headless chromium under Playwright typically needs on the order
of 512MB–1GB of headroom on top of the Node process and the SQLite
working set; undersized memory tiers are a known cause of chromium
crashing mid-navigation rather than a clean error. Size accordingly (see
verdict for why this is a public-knowledge estimate, not a
locally-measured one).

### Recommended host: Fly.io

Cheapest viable path for a ~2-week judge window: one `shared-cpu-1x` /
512MB–1GB Fly.io VM running this single container, plus a 1GB Fly Volume for
`/data`. Fly's per-second billing and `fly scale count 0`-when-idle make a
2-week judge window cheap even at the 1GB tier, and — critically for this
app — Fly VMs are persistent (not scale-to-zero-on-every-request like some
serverless platforms), so the in-process demo-store + socat-sidecar
architecture in `entrypoint.sh` keeps working exactly as designed.

```bash
# fly launch scaffolds a fly.toml at the repo root from the Dockerfile —
# this spike didn't generate platform config, only the Dockerfile/compose,
# so expect to hand-edit the scaffolded file before the first real deploy.
fly launch --no-deploy --dockerfile deploy/Dockerfile

# In the generated fly.toml, set:
#   [http_service]
#     internal_port = 8080        # PUBLIC_PORT, not the facilitator's own 8790
#   [[mounts]]
#     source = "hundi_data"
#     destination = "/data"

fly volumes create hundi_data --size 1 --region <region>
fly secrets set RAZORPAY_KEY_ID=rzp_test_xxx RAZORPAY_KEY_SECRET=xxx \
  RAZORPAY_WEBHOOK_SECRET=xxx DASHBOARD_TOKEN=xxx ADMIN_TOKEN=xxx
fly deploy
```

**Railway** is the close second choice — simpler UI/UX for a judge audience
that might poke at the dashboard, native volume support, but historically
pricier at sustained low-traffic than Fly's shared-cpu tier. Use it if Fly's
CLI-first flow is a blocker; the Dockerfile/compose here are
platform-agnostic and need no changes either way.

**Hetzner VPS** (or any bare VM) is the fallback if both PaaS options hit
an unexpected wall (e.g. a platform-specific networking quirk with the
socat sidecar that isn't visible from static review): `docker compose -f
deploy/docker-compose.yml up -d` on a €4/mo CX22, a reverse-proxy-free path
since you control the whole network stack, and no cold-start/scale-to-zero
behavior to fight. More setup work (manual TLS, no built-in health checks),
so only worth it if the PaaS options prove genuinely blocked.

## Verdict

**WORKS-WITH-CAVEATS — unverified on this machine (no Docker installed),
verified by design review + source-reading instead.**

`docker` is not installed on the machine this spike ran on (checked
`which docker`, `/Applications`, `/usr/local/bin`, `/opt/homebrew/bin`,
and podman/colima/lima/nerdctl as alternates — none present). Per the
task's own instruction, this spike did **not** fake a build/run/capture
result. Everything below is either read directly from source or reasoned
from the Dockerfile/entrypoint's own logic — clearly separated from what
would need an actual `docker build && docker run` to confirm:

**Verified by reading the actual source (high confidence, not guesses):**
- `checkout-driver.ts` navigates to `http://localhost:${server.port}/...`
  — a same-process HTTP server it starts itself. This holds inside any
  single container unconditionally; Docker's network model doesn't affect
  same-process loopback traffic at all.
- The facilitator resolves `@hundi/core` through its `dist/` build (bare
  specifier import, not the `workspace:*` symlink alone) — confirmed by
  grepping every `@hundi/core` and `@hundi/cli` import site in
  `packages/facilitator/src`; only `@hundi/cli/scanner` (a source-file
  subpath export) is imported from that package, so building `@hundi/cli`'s
  own `dist/` is for parity/safety, not a hard requirement.
- `openDb()` creates the SQLite file (and applies idempotent
  `IF NOT EXISTS` schema) if it doesn't exist — no separate DB
  initialization step needed before first boot.
- `mcr.microsoft.com/playwright:v1.62.0-noble`-family images have shipped
  Node 24.x in the same generation this repo pins (confirmed via a
  since-fixed GitHub issue about a stale Node 24.17.0 vs 24.18.0 patch in
  the `v1.61.1-noble` image) — satisfies this repo's `engines.node >= 24`.

**Designed and internally consistent, but not run end-to-end (medium
confidence — this is where a real `docker build` could still surprise):**
- The native `better-sqlite3` compile succeeding against whatever
  Python/toolchain versions actually ship in the `-noble` base (the
  Dockerfile installs `python3 make g++` explicitly rather than assuming
  the Playwright image ships them, since that image is optimized for
  browser automation, not native Node addon builds).
- The exact `v1.62.1-noble` tag existing in the registry — Playwright has
  had at least one prior release cycle (`v1.62.0`) where a tag was
  temporarily missing from Microsoft's registry after the npm publish (see
  Dockerfile comment). If `docker build` 404s on the tag, fall back to
  `v1.62.0-noble` (same minor version, same bundled chromium revision
  family) and re-run.
- The `entrypoint.sh` port-wait loop, the demo store + facilitator sharing
  loopback inside one container, and the socat public-port relay — each
  piece is a well-understood, standard technique individually, but the
  combination has not been exercised.

**Not evaluated at all (out of reach without Docker):** actual image size,
actual memory footprint under a live chromium session, actual in-container
capture latency. The "512MB–1GB" and image-size figures in this doc are
industry-typical numbers for Playwright-in-Docker, not measurements taken
from this build.

**What to run on first Docker-capable machine, in order, to close this
out** (each maps to a "designed but unverified" bullet above):

```bash
docker build -f deploy/Dockerfile -t hundi-facilitator .   # closes the tag + native-compile bullets
docker images hundi-facilitator                             # actual image size
docker run --rm -p 8080:8080 --env-file deploy/.env -v hundi-data:/data hundi-facilitator
curl -sS http://localhost:8080/stores                       # closes the socat-relay bullet
docker exec -it hundi-facilitator sh -c "cd packages/facilitator && npx tsx bin/smoke-settle.ts"
docker stats hundi-facilitator --no-stream                  # actual memory footprint
```

If all five close green, this graduates to **WORKS** outright — nothing in
the design is expected to fail, this is a verification gap, not a known
defect. If `smoke:settle` fails specifically inside the container while
`pnpm --filter @hundi/facilitator smoke:settle` still passes on bare metal,
suspect the chromium/toolchain mismatch bullet first.

## Verdict update (verified live, 2026-08-24)

Built and ran on this machine via colima (docker 29.5.2):
- Image builds clean: `hundi:spike`, **4.7 GB** (playwright/noble base; slimming possible later, not blocking).
- Container boots: demo store (127.0.0.1:8791) + facilitator (127.0.0.1:8790) + socat public proxy (**0.0.0.0:8080** — map your host port to 8080, not 8790).
- `GET /stores` 200 through the proxy; demo store auto-seeded (20 products).
- **Full live capture inside the container: PASSED** — mandate registered via ceremony endpoints, below-threshold settlement, in-container chromium drove the Razorpay TEST netbanking flow to `captured`.

Status: **WORKS.** Fly.io/Railway deploy per the commands above; remember the public port is 8080 and webhooks need the deployed URL registered in the Razorpay dashboard.
