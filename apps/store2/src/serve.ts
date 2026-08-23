/**
 * Serves the pre-rendered dist/ directory as plain files — no
 * request-time rendering, no framework. apps/store proves the CLI's
 * scanner works against a live server-rendered app; this proves it also
 * works against a directory of static files with nothing in front of them.
 */

import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DIST_DIR = join(__dirname, '..', 'dist')
const PORT = 8792
const HOST = '127.0.0.1'

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
}

/** Resolves a request path against DIST_DIR, rejecting anything that
 * normalizes outside of it (`..` traversal) rather than silently
 * clamping — an invalid path is a 404, not a redirect to the index. */
function resolvePath(urlPath: string): string | undefined {
  const decoded = decodeURIComponent(urlPath.split('?')[0] || '/')
  const rel = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '')
  const resolved = normalize(join(DIST_DIR, rel))
  if (resolved !== DIST_DIR && !resolved.startsWith(`${DIST_DIR}/`)) return undefined
  return resolved
}

export function createStaticServer() {
  return createServer((req, res) => {
    const filePath = req.url ? resolvePath(req.url) : undefined
    if (!filePath) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
      return
    }
    readFile(filePath)
      .then((body) => {
        const type = CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream'
        res.writeHead(200, { 'content-type': type })
        res.end(body)
      })
      .catch(() => {
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('not found')
      })
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createStaticServer().listen(PORT, HOST, () => {
    console.log(`hundi store2 (static) listening on http://${HOST}:${PORT}`)
  })
}
