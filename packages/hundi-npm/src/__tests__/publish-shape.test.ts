/**
 * Guards the two things that make `npm publish` from this package actually
 * work for a stranger running `npx hundi init <url>`: the bundle tsup emits
 * is self-contained (no dangling `@hundi/*` workspace import that would only
 * resolve inside this monorepo), and package.json's publish-facing fields
 * (name, bin, files) match what npm needs to wire up the `hundi` binary.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const distEntry = join(packageRoot, 'dist', 'cli.js')
const tsupBin = join(packageRoot, 'node_modules', '.bin', 'tsup')

describe('built dist/cli.js', () => {
  beforeAll(() => {
    execFileSync(tsupBin, [], { cwd: packageRoot, stdio: 'inherit' })
  }, 120_000)

  it('is emitted at the path package.json declares as the bin', () => {
    expect(existsSync(distEntry)).toBe(true)
  })

  it('starts with a node shebang so it runs directly once installed', () => {
    const contents = readFileSync(distEntry, 'utf8')
    expect(contents.startsWith('#!/usr/bin/env node')).toBe(true)
  })

  it('bundles @hundi/cli in — no workspace-only import survives to the built output', () => {
    const contents = readFileSync(distEntry, 'utf8')
    expect(contents).not.toMatch(/@hundi\//)
  })
})

describe('package.json publish shape', () => {
  const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
    name: string
    private?: boolean
    bin?: Record<string, string>
    files?: string[]
    dependencies?: Record<string, string>
    license?: string
  }

  it('publishes under the "hundi" package name', () => {
    expect(pkg.name).toBe('hundi')
  })

  it('exposes a "hundi" bin pointing at the built CLI', () => {
    expect(pkg.bin).toEqual({ hundi: './dist/cli.js' })
  })

  it('ships only dist and README in the published tarball', () => {
    expect(pkg.files).toEqual(['dist', 'README.md'])
  })

  it('declares no runtime dependencies — the bundle is fully self-contained', () => {
    expect(pkg.dependencies).toBeUndefined()
  })

  it('is not marked private, so `npm publish` is not blocked', () => {
    expect(pkg.private).toBeUndefined()
  })

  it('declares an MIT license', () => {
    expect(pkg.license).toBe('MIT')
  })
})
