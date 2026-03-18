const { https } = require('follow-redirects')
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const vscode = require('vscode')

class Speaker {

  static #binaryPath = null
  static #binaryReady = false
  static #binaryDownloading = false
  static #currentPlayProcess = null

  static async setupSpeaker(context, statusBarItem) {
    if (!this.#assetName) {
      vscode.window.showErrorMessage('Unsupported platform for play-buffer')
      return
    }
    if (!Speaker.#binaryReady) await Speaker.#downloadPlayBuffer(context)
    statusBarItem.text = 'Akaza: Ready ❄️'
  }

  static stopAllProcesses() {
    Speaker.#killCurrentProcess()
  }

  // Spawn a fresh process per note — no backpressure, overlapping playback handled by OS
  static sendNoteToSpeaker(buffer) {
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
  static sendToSpeaker(buffer, onFinish = null) {
    if (!Speaker.#binaryPath || !Buffer.isBuffer(buffer) || !buffer.length) {
      vscode.window.showErrorMessage('play-buffer: invalid buffer or binary missing')
      return
    }
    Speaker.#killCurrentProcess()
    vscode.commands.executeCommand('setContext', 'akazas-love.playing', true)
    const proc = spawn(Speaker.#binaryPath, [], { stdio: ['pipe', 'ignore', 'ignore'] })
    Speaker.#currentPlayProcess = proc
    proc.stdin.write(buffer)
    proc.stdin.end()
    proc.on('error', e => vscode.window.showWarningMessage('play-buffer error: ' + e.message))
    proc.on('exit', (_, signal) => {
      Speaker.#currentPlayProcess = null
      vscode.commands.executeCommand('setContext', 'akazas-love.playing', false)
      if (signal == null && onFinish) onFinish()
    })
  }

  static stopToSpeaker() {
    if (Speaker.#currentPlayProcess && !Speaker.#currentPlayProcess.killed) Speaker.#killCurrentProcess()
  }

  static async redownloadPlayBuffer(context) {
    await Speaker.#downloadPlayBuffer(context, true)
  }

  static #killCurrentProcess() {
    if (!Speaker.#currentPlayProcess || Speaker.#currentPlayProcess.killed) return
    try { Speaker.#currentPlayProcess.stdin.end(); Speaker.#currentPlayProcess.kill() } catch (e) { /* ignore */ }
  }

  static get #assetName() {
    const p = process.platform
    if (p === 'win32') return 'play_buffer_windows.exe'
    if (p === 'darwin') return 'play_buffer_macos'
    if (p === 'linux') return 'play_buffer_linux'
  }

  static async #downloadPlayBuffer(context, force = false) {
    if (Speaker.#binaryReady && !force) return
    if (Speaker.#binaryDownloading) { vscode.window.showWarningMessage('play-buffer still downloading'); return }
    if (!force) {
      Speaker.#binaryPath = path.join(context.extensionPath, 'bin', this.#assetName)
      fs.mkdirSync(path.dirname(Speaker.#binaryPath), { recursive: true })
      if (fs.existsSync(Speaker.#binaryPath)) { Speaker.#binaryReady = true; return }
    }
    Speaker.#binaryDownloading = true
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
          vscode.window.showInformationMessage('play-buffer downloaded! 🚀')
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
