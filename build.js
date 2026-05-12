const esbuild = require('esbuild')
const path = require('path')
const fs = require('fs')

const isDev = process.argv.includes('--dev')

// Packages that use @mapbox/node-pre-gyp (native addons) must all be external —
// node-pre-gyp internally requires mock-aws-s3, aws-sdk, nock, and an .html file
// that esbuild cannot bundle. Externalising the top-level package is enough.
const NATIVE_EXTERNALS = [
  'uiohook-napi',
  'mpg123-decoder',
  'node-liblzma',
  'get-windows',       // uses node-pre-gyp
  'active-win',        // uses ffi-napi / node-pre-gyp
  '@tonejs/midi',
  'follow-redirects',
]

// ── VSCode extension ───────────────────────────────────────────────────────

esbuild.build({
  entryPoints: [path.resolve(__dirname, 'src/extension.js')],
  bundle: true,
  minify: !isDev,
  platform: 'node',
  target: ['node24'],
  outfile: path.resolve(__dirname, 'dist/extension.js'),
  sourcemap: isDev,
  logLevel: 'info',
  external: ['vscode', ...NATIVE_EXTERNALS],
}).catch(() => process.exit(1))

// ── VSCode webview HTML ────────────────────────────────────────────────────
// minify is ESM-only (can't require() it from CJS), so we do a simple
// whitespace-collapse instead — good enough for a webview panel.
function minifyHtml(src) {
  return fs.readFileSync(src, 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '')      // strip comments
    .replace(/\s{2,}/g, ' ')             // collapse whitespace
    .replace(/>\s+</g, '><')             // remove whitespace between tags
    .trim()
}
fs.mkdirSync(path.resolve(__dirname, 'dist'), { recursive: true })
fs.writeFileSync('dist/index.html', minifyHtml('standalone/index.html'))

// ── Electron standalone ────────────────────────────────────────────────────

const STANDALONE_OUT = path.resolve(__dirname, 'dist/standalone')
fs.mkdirSync(STANDALONE_OUT, { recursive: true })

esbuild.build({
  entryPoints: [path.resolve(__dirname, 'standalone/main.js')],
  bundle: true,
  minify: !isDev,
  platform: 'node',
  target: ['node20'],  // Electron ships its own Node; 20 is safe for current Electron
  outfile: path.join(STANDALONE_OUT, 'main.js'),
  sourcemap: isDev,
  logLevel: 'info',
  external: ['electron', ...NATIVE_EXTERNALS],
}).catch(() => process.exit(1))

// Copy preload unbundled — Electron loads it in a separate sandboxed context
fs.copyFileSync(
  path.resolve(__dirname, 'standalone/preload.js'),
  path.join(STANDALONE_OUT, 'preload.js')
)

// Copy HTML as-is — no bundling needed for the renderer
fs.copyFileSync(
  path.resolve(__dirname, 'standalone/index.html'),
  path.join(STANDALONE_OUT, 'index.html')
)

console.log('Build complete.')
