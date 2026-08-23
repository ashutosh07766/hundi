/**
 * Persistent identity for this MCP server process — the one agent Ed25519
 * keypair every purchase it drives is signed with. Minted once on first run
 * and re-read on every later start, so a human authorizes this agent's
 * public key in a dashboard mandate ceremony exactly once, not on every
 * launch. The private key never leaves this file/process; only
 * `publicKeyHex` is ever handed to a caller (see tools/get-agent-identity.ts).
 *
 * Produces the same `{ privateKey: KeyObject, publicKeyHex }` shape as
 * agents/scripted-brain/src/ed25519.ts's `AgentKeypair` — structurally
 * compatible with every function in that module (`signPayload`,
 * `HttpBuyerTools.requestPayment`, ...) without importing it, since this
 * module's whole job is persistence around the same node:crypto ed25519
 * primitive, not a different signing scheme.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AgentKeypair } from '../../../agents/scripted-brain/src/ed25519.js'

type StoredKey = { privateKeyPkcs8Pem: string; publicKeyHex: string }

// Mirrors ed25519.ts's own base64UrlToHex exactly — the JWK 'x' coordinate is
// how node:crypto exposes a raw Ed25519 public key, and both modules need to
// turn that into the hex string the mandate-chain types expect.
function base64UrlToHex(b64url: string): string {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(b64, 'base64').toString('hex')
}

/** `HUNDI_AGENT_KEY_FILE` when set, else `~/.hundi/mcp-agent-key.json`. */
export function defaultKeyFilePath(): string {
  const override = process.env.HUNDI_AGENT_KEY_FILE?.trim()
  return override && override.length > 0
    ? override
    : path.join(os.homedir(), '.hundi', 'mcp-agent-key.json')
}

function readStoredKey(filePath: string): StoredKey | undefined {
  if (!fs.existsSync(filePath)) return undefined
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as StoredKey
}

// chmod 600 — this file holds the only copy of the agent's private key.
function writeStoredKey(filePath: string, key: StoredKey): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(key, null, 2), { mode: 0o600 })
  fs.chmodSync(filePath, 0o600)
}

/**
 * Loads the agent identity from `filePath`, minting and persisting a fresh
 * Ed25519 keypair the first time it's called for that path. Every later call
 * for the same path returns the same public key — that stability is the
 * entire point: it's what lets a human paste this key into a mandate once
 * and have it keep working across restarts.
 */
export function loadOrCreateAgentIdentity(filePath: string = defaultKeyFilePath()): AgentKeypair {
  const stored = readStoredKey(filePath)
  if (stored) {
    const privateKey = crypto.createPrivateKey({ key: stored.privateKeyPkcs8Pem, format: 'pem' })
    return { privateKey, publicKeyHex: stored.publicKeyHex }
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string }
  const publicKeyHex = base64UrlToHex(jwk.x)
  const privateKeyPkcs8Pem = privateKey.export({ format: 'pem', type: 'pkcs8' }) as string
  writeStoredKey(filePath, { privateKeyPkcs8Pem, publicKeyHex })
  return { privateKey, publicKeyHex }
}
