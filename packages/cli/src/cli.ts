#!/usr/bin/env node
/**
 * `hundi init <url>` — scans a schema.org storefront and writes the
 * agent-readable surface (llms.txt, .well-known/hundi.json,
 * catalog-adapter.json) into an output directory, optionally registering the
 * merchant with a facilitator. Fails loud: an unreachable store or a scan
 * that yields zero products exits non-zero with a clear message rather than
 * writing an empty/misleading surface.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { generateCatalogAdapter, generateLlmsTxt, generateManifest } from './generators.js'
import { registerMerchant } from './register.js'
import { scanStore } from './scanner.js'

function printUsage(): void {
  console.log(`Usage: hundi init <url> [options]

Scans a schema.org store and generates the Hundi agent surface: llms.txt,
.well-known/hundi.json, and catalog-adapter.json.

Options:
  --out <dir>            Output directory (default: ./hundi-out)
  --facilitator <url>    Facilitator base URL (required with --register)
  --admin-token <token>  Facilitator admin token (required with --register)
  --register             Register the scanned merchant with the facilitator
  -h, --help             Show this help
`)
}

async function runInit(
  url: string,
  options: {
    out: string
    facilitator: string | undefined
    adminToken: string | undefined
    register: boolean
  },
): Promise<number> {
  console.log(`Scanning ${url} ...`)

  let store: Awaited<ReturnType<typeof scanStore>>
  try {
    store = await scanStore(url)
  } catch (err) {
    console.error(`Failed to scan ${url}: ${err instanceof Error ? err.message : String(err)}`)
    return 1
  }

  if (store.products.length === 0) {
    console.error(`No products found at ${url}.`)
    for (const warning of store.warnings) console.error(`  - ${warning}`)
    return 1
  }

  await mkdir(join(options.out, '.well-known'), { recursive: true })
  await writeFile(join(options.out, 'llms.txt'), generateLlmsTxt(store), 'utf8')
  await writeFile(
    join(options.out, '.well-known', 'hundi.json'),
    `${JSON.stringify(generateManifest(store), null, 2)}\n`,
    'utf8',
  )
  await writeFile(
    join(options.out, 'catalog-adapter.json'),
    `${JSON.stringify(generateCatalogAdapter(store), null, 2)}\n`,
    'utf8',
  )

  console.log(`\nScanned ${store.merchant_id}: ${store.products.length} product(s) found.`)
  console.log(`Wrote llms.txt, .well-known/hundi.json, catalog-adapter.json to ${options.out}/`)
  if (store.warnings.length > 0) {
    console.log(`\nWarnings (${store.warnings.length}):`)
    for (const warning of store.warnings) console.log(`  - ${warning}`)
  }

  if (options.register) {
    if (!options.facilitator || !options.adminToken) {
      console.error('\n--register requires --facilitator and --admin-token')
      return 1
    }
    console.log(`\nRegistering ${store.merchant_id} with facilitator at ${options.facilitator} ...`)
    try {
      const result = await registerMerchant({
        facilitatorUrl: options.facilitator,
        adminToken: options.adminToken,
        store,
      })
      console.log(
        result.status === 'already_registered'
          ? `Merchant ${store.merchant_id} is already registered.`
          : `Merchant ${store.merchant_id} registered.`,
      )
    } catch (err) {
      console.error(
        `Failed to register merchant: ${err instanceof Error ? err.message : String(err)}`,
      )
      return 1
    }
  }

  return 0
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2)

  if (command === '-h' || command === '--help' || command === undefined) {
    printUsage()
    return command === undefined ? 1 : 0
  }

  if (command !== 'init') {
    console.error(`Unknown command: ${command}\n`)
    printUsage()
    return 1
  }

  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      out: { type: 'string', default: 'hundi-out' },
      facilitator: { type: 'string' },
      'admin-token': { type: 'string' },
      register: { type: 'boolean', default: false },
    },
    allowPositionals: true,
  })

  const url = positionals[0]
  if (!url) {
    console.error('Error: missing <url>\n')
    printUsage()
    return 1
  }

  return runInit(url, {
    out: values.out ?? 'hundi-out',
    facilitator: values.facilitator,
    adminToken: values['admin-token'],
    register: values.register ?? false,
  })
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
