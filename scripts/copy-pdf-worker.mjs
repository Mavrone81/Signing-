// Copies the pdf.js worker out of node_modules into `public/` so it is served
// locally (this app runs air-gapped/offline — no CDN worker). Setting
// `GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs'` in the Viewer then
// resolves to this copied file. Runs on `prebuild`/`predev`/`postinstall`, and
// the copy is also committed so `next build` (incl. standalone output, which
// bundles `public/`) always has it even if the hook is skipped.
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const src = require.resolve('pdfjs-dist/build/pdf.worker.min.mjs')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dest = resolve(root, 'public', 'pdf.worker.min.mjs')

mkdirSync(dirname(dest), { recursive: true })
copyFileSync(src, dest)
console.log(`Copied pdf.js worker -> ${dest}`)
