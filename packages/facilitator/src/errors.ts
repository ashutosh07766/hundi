/**
 * Every route signals failure by throwing `RouteError` and letting the
 * app-level `onError` handler (see app.ts) turn it into a response. This
 * keeps route bodies free of repeated try/catch-and-format boilerplate and
 * guarantees every error response — auth, validation, conflict, or verify
 * rejection — carries the same `{ok:false,error,reason?}` shape.
 */

export type HttpStatus = 200 | 201 | 202 | 400 | 401 | 404 | 409 | 500

export class RouteError extends Error {
  readonly status: HttpStatus
  readonly code: string
  readonly detail: string | undefined

  constructor(status: HttpStatus, code: string, detail?: string) {
    super(detail ?? code)
    this.name = 'RouteError'
    this.status = status
    this.code = code
    this.detail = detail
  }
}

export type ApiErrorBody = { ok: false; error: string; reason?: string }

/** `error` is always the machine-readable code; `reason`, when present, is a human detail. */
export function errorBody(code: string, detail?: string): ApiErrorBody {
  return detail === undefined
    ? { ok: false, error: code }
    : { ok: false, error: code, reason: detail }
}

/** better-sqlite3 puts the SQLite result code on `.code`, e.g. 'SQLITE_CONSTRAINT_UNIQUE'. */
export function isSqliteConstraintError(err: unknown): err is Error & { code: string } {
  return (
    err instanceof Error &&
    'code' in err &&
    typeof (err as { code: unknown }).code === 'string' &&
    (err as { code: string }).code.startsWith('SQLITE_CONSTRAINT')
  )
}
