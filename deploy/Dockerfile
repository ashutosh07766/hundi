# Build from the repo root: docker build -f deploy/Dockerfile -t hundi-facilitator .
#
# Base image is Microsoft's official Playwright image so the chromium build
# baked into the image matches the `playwright` npm package's own bundled
# browser revision — installing a mismatched chromium separately is the
# most common source of "browser not found" / protocol-version failures in
# containerized Playwright. Pin this tag to the *exact* playwright version
# in packages/facilitator/package.json (pnpm-lock.yaml resolves it further —
# check `playwright@` there) whenever that dependency is bumped; a
# major/minor drift between image and npm package is not guaranteed to work.
FROM mcr.microsoft.com/playwright:v1.62.1-noble

# better-sqlite3 (packages/facilitator) compiles a native addon on install.
# The playwright image ships Node + browsers but not a C/C++ toolchain.
# socat is the sidecar proxy — see entrypoint.sh for why the facilitator
# process itself cannot be the thing listening on a public interface.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 \
      make \
      g++ \
      socat \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /app

# Copy the whole workspace in one layer rather than staging manifests first.
# pnpm's workspace install needs every package.json under pnpm-workspace.yaml's
# globs (packages/*, apps/*, agents/*, spikes, demo) to resolve the lockfile;
# splitting that across two COPY layers buys cache reuse only when *no*
# source file changes between builds, which is not the common case for a
# fast-moving repo this size (~7MB excluding node_modules/dist). Simplicity
# over marginal cache wins.
COPY . .

# --frozen-lockfile: fail the build rather than silently drift from
# pnpm-lock.yaml. onlyBuiltDependencies (root package.json) already
# allowlists better-sqlite3's install script, so no extra
# --allow-build flag is needed here. playwright's own postinstall (browser
# download) is NOT allowlisted and will be skipped by pnpm 10's default
# script-blocking policy — intentionally: this base image already has
# chromium baked in at the path PLAYWRIGHT_BROWSERS_PATH points to, so
# skipping the download is a no-op, not a missing step.
RUN pnpm install --frozen-lockfile

# @hundi/facilitator imports `@hundi/core` by its bare package name, which
# Node resolves through @hundi/core's package.json "main" (./dist/index.js)
# — a workspace `link:` symlink does not make that file appear on its own.
# tsx transpiles the facilitator's *own* TypeScript at runtime but does not
# build its workspace dependencies, so @hundi/core must be compiled ahead of
# time. @hundi/cli is built alongside it for parity with every other
# workspace consumer of its dist build, even though the facilitator only
# ever imports @hundi/cli's `./scanner` subpath export, which points at a
# source .ts file directly and needs no build step.
RUN pnpm --filter @hundi/core build && pnpm --filter @hundi/cli build

COPY deploy/entrypoint.sh /app/deploy/entrypoint.sh
RUN chmod +x /app/deploy/entrypoint.sh

ENV NODE_ENV=production
# Overridden at runtime via --env-file / compose env_file — DB_PATH must
# point inside a mounted volume or every restart starts from an empty ledger.
ENV DB_PATH=/data/hundi.db
VOLUME ["/data"]

# 8080 is the only port meant to be reachable from outside the container —
# see entrypoint.sh. The facilitator's own bind (PORT, default 8790) and the
# in-container checkout host page (CHECKOUT_PAGE_PORT, default 8788) are
# both loopback-only by design and are deliberately not published here.
EXPOSE 8080

ENTRYPOINT ["/app/deploy/entrypoint.sh"]
