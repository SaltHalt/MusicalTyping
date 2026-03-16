const esbuild = require('esbuild')
const path = require('path')

const isDev = process.argv.includes('--dev')

esbuild.build({
  entryPoints: [path.resolve(__dirname, 'src/extension.js')],
  bundle: true,
  minify: !isDev,
  platform: 'node',
  target: ['node24'],
  outfile: path.resolve(__dirname, 'dist/extension.js'),
  sourcemap: true,
  logLevel: 'info',
  external: ['vscode', 'mpg123-decoder']
}).catch(() => process.exit(1))

const minify = require('minify').minify

minify('src/index.html')
  .then(minified => require('fs').writeFileSync('dist/index.html', minified))
  .catch(console.error)
