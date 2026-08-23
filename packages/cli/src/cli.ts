#!/usr/bin/env node
/**
 * Workspace bin entry point — see `run.ts` for the actual command logic.
 * Kept to a single unconditional invocation so this file is never imported
 * as a module (only ever executed directly as `hundi`/`tsx src/cli.ts`);
 * anything that needs `runCli` programmatically (tests, or a wrapper that
 * bundles this package under a different binary name) imports it from
 * `./run.js` / `@hundi/cli/run` instead.
 */

import { runCli } from './run.js'

runCli(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code
  })
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
