#!/usr/bin/env node
/**
 * Published entry point for `npx hundi init <url>`. This package exists
 * solely to give the workspace-internal `@hundi/cli` a globally installable,
 * dependency-free binary — every behavior (argument parsing, SSRF-guarded
 * scanning, file generation, facilitator registration) lives in `@hundi/cli`
 * and is bundled in at build time. This file must never re-implement or
 * fork that logic.
 */
import { runCli } from '@hundi/cli/run'

runCli(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code
  })
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
