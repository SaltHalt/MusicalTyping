const { https } = require('follow-redirects')
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

// Speaker is vscode-free. Callers inject callbacks for status/error reporting
// so this module works identically in the VSCode extension and Electron standalone.

class Speaker {
  static #binaryPath = null
  static #binaryReady = false
  static #binaryDownloading = false
  static #currentPlayProcess = null

  // Injected by the caller — default to console so it always works
  static #onStatus = (msg) => console.log('[Speaker]', msg)
  static #onError  = (msg) => console.error('[Speaker]', msg)
  static #onPlayingChanged = (_isPlaying) => {}

  /**
   * @param {string}   binDir              - directory to store the downloaded binary 
   * context.extensionPath, 'bin'
   * @param {object}   [callbacks]
   * @param {function} [callbacks.onStatus]        - (message: string) => void
   * @param {function} [callbacks.onError]         - (message: string) => void
   * @param {function} [callbacks.onPlayingChanged] - (isPlaying: boolean) => void
   */
  static async setupSpeaker(binDir, { onStatus, onError, onPlayingChanged } = {}) {
    if (onStatus)        this.#onStatus        = onStatus
    // vscode.window.showInformationMessage
    if (onError)         this.#onError         = onError
    // vscode.window.showWarningMessage
    if (onPlayingChanged) this.#onPlayingChanged = onPlayingChanged 
    //  vscode.commands.executeCommand('setContext', 'akazas-love.playing', true)

    if (!this.#assetName) {
      this.#onError('Unsupported platform for play-buffer')
      return
    }
    if (!Speaker.#binaryReady) await Speaker.#downloadPlayBuffer(binDir)
  }

  static stopAllProcesses() {
    Speaker.#killCurrentProcess()
  }

  // Spawn a fresh process per note — no backpressure, overlapping playback handled by OS
  static sendNoteToSpeaker(arr) {
    const buffer = Buffer.from(arr.buffer)
    if (!Speaker.#binaryPath || !Buffer.isBuffer(buffer) || !buffer.length) return
    try {
      const proc = spawn(Speaker.#binaryPath, [], { stdio: ['pipe', 'ignore', 'ignore'] })
      proc.stdin.write(buffer)
      proc.stdin.end()
      proc.on('error', e => console.error('play-buffer note error:', e))
    } catch (e) {
      console.error('sendNoteToSpeaker:', e)
    }
  }

  // For full-song playback (pre-rendered, stoppable)
  static sendToSpeaker(arr, onFinish = null) {
    const buffer = Buffer.from(arr.buffer)
    if (!Speaker.#binaryPath || !Buffer.isBuffer(buffer) || !buffer.length) {
      this.#onError('play-buffer: invalid buffer or binary missing')
      return
    }
    Speaker.#killCurrentProcess()
    this.#onPlayingChanged(true)
    const proc = spawn(Speaker.#binaryPath, [], { stdio: ['pipe', 'ignore', 'ignore'] })
    Speaker.#currentPlayProcess = proc
    proc.stdin.write(buffer)
    proc.stdin.end()
    proc.on('error', e => this.#onError('play-buffer error: ' + e.message))
    proc.on('exit', (_, signal) => {
      if (Speaker.#currentPlayProcess === proc) {
        Speaker.#currentPlayProcess = null
        this.#onPlayingChanged(false)
        if (signal == null && onFinish) onFinish()
      }
    })
  }

  static stopToSpeaker() {
    if (Speaker.#currentPlayProcess && !Speaker.#currentPlayProcess.killed) Speaker.#killCurrentProcess()
  }

  static async redownloadPlayBuffer(binDir) {
    await Speaker.#downloadPlayBuffer(binDir, true)
  }

  static #killCurrentProcess() {
    if (!Speaker.#currentPlayProcess || Speaker.#currentPlayProcess.killed) return
    try { Speaker.#currentPlayProcess.stdin.end(); Speaker.#currentPlayProcess.kill() } catch (e) { /* ignore */ }
  }

  static get #assetName() {
    const p = process.platform
    if (p === 'win32') return 'play_buffer_windows.exe'
    if (p === 'darwin') return 'play_buffer_macos'
    if (p === 'linux')  return 'play_buffer_linux'
  }

  static async #downloadPlayBuffer(binDir, force = false) {
    if (Speaker.#binaryReady && !force) return
    if (Speaker.#binaryDownloading) { this.#onError('play-buffer still downloading'); return }

    Speaker.#binaryPath = path.join(binDir, this.#assetName)
    fs.mkdirSync(path.dirname(Speaker.#binaryPath), { recursive: true })
    if (!force && fs.existsSync(Speaker.#binaryPath)) { Speaker.#binaryReady = true; return }

    Speaker.#binaryDownloading = true
    this.#onStatus('Downloading play-buffer…')
    const asset = await this.#getAssetInfo()
    await new Promise((resolve, reject) => {
      https.get(asset.browser_download_url, res => {
        if (res.statusCode !== 200) {
          Speaker.#binaryDownloading = false
          return reject(new Error('Download failed: ' + res.statusCode))
        }
        const file = fs.createWriteStream(Speaker.#binaryPath)
        res.pipe(file)
        file.on('finish', () => {
          file.close()
          try { if (process.platform !== 'win32') fs.chmodSync(Speaker.#binaryPath, '755') } catch (e) { /* ignore */ }
          Speaker.#binaryReady = true
          Speaker.#binaryDownloading = false
          this.#onStatus('play-buffer downloaded! 🚀')
          resolve()
        })
        file.on('error', e => { Speaker.#binaryDownloading = false; reject(e) })
      }).on('error', e => { Speaker.#binaryDownloading = false; reject(e) })
    })
  }

  static async #getAssetInfo() {
    const data = await new Promise((resolve, reject) => {
      https.get('https://api.github.com/repos/lanly-dev/play-buffer/releases/latest',
        { headers: { 'User-Agent': 'akazas-love-extension' } }, res => {
          let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)) } catch (e) { reject(e) } })
        }).on('error', reject)
    })
    const asset = data.assets.find(a => a.name === Speaker.#assetName)
    if (!asset) throw new Error('No compatible binary found')
    return asset
  }
}

module.exports = Speaker
