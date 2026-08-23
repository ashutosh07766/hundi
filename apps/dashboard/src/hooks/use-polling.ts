import { useEffect, useRef, useState } from 'react'

export type PollingState<T> = {
  data: T | null
  error: string | null
  loading: boolean
}

/**
 * Polls `fetcher` every `intervalMs`, firing immediately on mount. A poll
 * failure sets `error` without clearing previously-loaded `data` — a
 * transient network hiccup shouldn't blank a screen that just had good
 * data (fail loud via the visible `error`, not via wiping the UI).
 *
 * `fetcher` is read through a ref updated on every render, so callers don't
 * need to memoize it — the effect itself only depends on `intervalMs`.
 */
export function usePolling<T>(fetcher: () => Promise<T>, intervalMs: number): PollingState<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher

  useEffect(() => {
    let cancelled = false

    async function tick() {
      try {
        const result = await fetcherRef.current()
        if (cancelled) return
        setData(result)
        setError(null)
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    tick()
    const id = setInterval(tick, intervalMs)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [intervalMs])

  return { data, error, loading }
}
