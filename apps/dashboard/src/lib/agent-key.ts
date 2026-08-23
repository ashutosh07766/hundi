/**
 * Persists the AGENT keypair a mandate ceremony mints, keyed by mandateId, so
 * a later "Run test purchase" click can sign a cart with it without asking the
 * operator to paste it back in. There is nothing to persist when the operator
 * supplied their own agent pubkey at ceremony time — the private half never
 * touched this browser — so that case is recorded as `external` instead, and
 * every call site that wants to drive a purchase treats `external` the same as
 * "no key available."
 */

export type AgentKeyRecord =
  | { kind: 'local'; secretKeyHex: string; publicKeyHex: string }
  | { kind: 'external' }

function storageKey(mandateId: string): string {
  return `hundi.agentKey.${mandateId}`
}

/** Records a minted-locally agent keypair for `mandateId`. */
export function saveLocalAgentKey(
  mandateId: string,
  keypair: { secretKeyHex: string; publicKeyHex: string },
): void {
  const record: AgentKeyRecord = { kind: 'local', ...keypair }
  localStorage.setItem(storageKey(mandateId), JSON.stringify(record))
}

/** Records that `mandateId`'s agent key was supplied externally — no private
 * half exists in this browser, so purchase-driving actions must stay disabled. */
export function markExternalAgentKey(mandateId: string): void {
  const record: AgentKeyRecord = { kind: 'external' }
  localStorage.setItem(storageKey(mandateId), JSON.stringify(record))
}

/** Returns null when nothing was ever recorded for `mandateId` (mandates
 * registered before this feature shipped, or corrupt storage) — treated
 * identically to `external` by every caller. */
export function loadAgentKeyRecord(mandateId: string): AgentKeyRecord | null {
  const raw = localStorage.getItem(storageKey(mandateId))
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as AgentKeyRecord
    if (parsed.kind === 'local' && parsed.secretKeyHex && parsed.publicKeyHex) return parsed
    if (parsed.kind === 'external') return parsed
  } catch {
    // Corrupt storage reads as "nothing recorded," not a crash.
  }
  return null
}
