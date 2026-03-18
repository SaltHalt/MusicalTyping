const { https } = require('follow-redirects')
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const vscode = require('vscode')

class Speaker {

  static #binaryPath = null
  static #binaryReady = false
  static #binaryDownloading = false

  // For full-song playback (pre-rendered, stoppable)
  static #currentPlayProcess = null

  // ── Public API ──────────────────────────────────────────────────────────────

  static async setupSpeaker(context, statusBarItem) {
    if (!this.#assetName) {
      vscode.window.showErrorMessage('Unsupported platform for play-buffer')
      return
    }
    try {
      if (!Speaker.#binaryReady) await Speaker.#downloadPlayBuffer(context)
      statusBarItem.text = 'Akaza: Ready ❄️'
      statusBarItem.tooltip = 'Akaza extension is ready!'
    } catch (e) {
      console.error('Failed to setup Speaker:', e)
    }
  }

  static stopAllProcesses() {
    try {
      Speaker.#killCurrentProcess()
    } catch (e) {
      console.error('Failed to stop Speaker processes:', e)
    }
  }

  // Spawn a fresh process per note. Each note gets its own pipe so there is no
  // backpressure or buffer reuse issue. The OS handles overlapping playback naturally.
  static sendNoteToSpeaker(buffer) {
    if (!Speaker.#binaryPath || !fs.existsSync(Speaker.#binaryPath)) return false
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) return false
    try {
      const proc = spawn(Speaker.#binaryPath, [], { stdio: ['pipe', 'ignore', 'ignore'] })
      proc.stdin.write(buffer)
      proc.stdin.end()
      proc.on('error', err => console.error('play-buffer note error:', err))
    } catch (e) {
      console.error('Speaker.sendNoteToSpeaker error:', e)
      return false
    }
    return true
  }

  // For full-song playback (pre-rendered PCM buffer, stoppable mid-play)
  static sendToSpeaker(buffer, onFinish = null) {
    if (!Speaker.#binaryPath || !fs.existsSync(Speaker.#binaryPath)) {
      vscode.window.showErrorMessage('play-buffer binary not found or not downloaded')
      return
    }
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      vscode.window.showErrorMessage('PCM buffer is invalid or empty')
      return
    }
    try {
      Speaker.#killCurrentProcess()
      vscode.commands.executeCommand('setContext', 'akazas-love.playing', true)
      const proc = spawn(Speaker.#binaryPath, [], { stdio: ['pipe', 'ignore', 'ignore'] })
      Speaker.#currentPlayProcess = proc
      proc.stdin.write(buffer)
      proc.stdin.end()
      proc.on('error', err => {
        vscode.window.showWarningMessage('Failed to play buffer: ' + err.message)
      })
      proc.on('exit', (code, signal) => {
        Speaker.#currentPlayProcess = null
        vscode.commands.executeCommand('setContext', 'akazas-love.playing', false)
        if (signal == null && onFinish) onFinish()
      })
    } catch (e) {
      vscode.window.showWarningMessage('Failed to play buffer: ' + e.message)
    }
  }

  static stopToSpeaker() {
    if (Speaker.#currentPlayProcess && !Speaker.#currentPlayProcess.killed) Speaker.#killCurrentProcess()
    else vscode.window.showInformationMessage('No active play process to stop')
  }

  static async redownloadPlayBuffer(context) {
    await Speaker.#downloadPlayBuffer(context, true)
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  static #killCurrentProcess() {
    if (!Speaker.#currentPlayProcess || Speaker.#currentPlayProcess.killed) return
    try {
      Speaker.#currentPlayProcess.stdin.end()
      Speaker.#currentPlayProcess.kill()
    } catch (e) {
      console.error('Failed to kill current playProcess:', e)
    }
  }

  static get #assetName() {
    const platform = process.platform
    if (platform === 'win32') return 'play_buffer_windows.exe'
    if (platform === 'darwin') return 'play_buffer_macos'
    if (platform === 'linux') return 'play_buffer_linux'
  }

  static async #downloadPlayBuffer(context, force = false) {
    if (Speaker.#binaryReady && !force) return
    if (Speaker.#binaryDownloading) {
      vscode.window.showWarningMessage('play-buffer binary is downloading')
      return
    }
    if (!force) {
      Speaker.#binaryPath = path.join(context.extensionPath, 'bin', this.#assetName)
      const binDir = path.dirname(Speaker.#binaryPath)
      if (!fs.existsSync(binDir)) fs.mkdirSync(binDir, { recursive: true })
      if (fs.existsSync(Speaker.#binaryPath)) {
        Speaker.#binaryReady = true
        return
      }
    }
    Speaker.#binaryDownloading = true
    const asset = await this.#getAssetInfo()
    await new Promise((resolve, reject) => {
      https.get(asset.browser_download_url, (response) => {
        if (response.statusCode !== 200) {
          let body = ''
          response.on('data', c => body += c)
          response.on('end', () => {
            Speaker.#binaryDownloading = false
            reject(new Error('Download failed: ' + response.statusCode))
          })
          return
        }
        const contentType = response.headers['content-type'] || ''
        const isBinary = contentType.includes('octet-stream') || contentType.includes('binary') || contentType === ''
        if (!isBinary) {
          Speaker.#binaryDownloading = false
          reject(new Error('Non-binary file: ' + contentType))
          return
        }
        const file = fs.createWriteStream(Speaker.#binaryPath)
        response.pipe(file)
        file.on('finish', () => {
          file.close()
          try {
            if (process.platform !== 'win32') fs.chmodSync(Speaker.#binaryPath, '755')
          } catch (e) { console.error('chmod failed:', e) }
          Speaker.#binaryReady = true
          Speaker.#binaryDownloading = false
          vscode.window.showInformationMessage('Downloaded play-buffer binary successfully! 🚀')
          resolve()
        })
        file.on('error', err => { Speaker.#binaryDownloading = false; reject(err) })
      }).on('error', err => { Speaker.#binaryDownloading = false; reject(err) })
    })
  }

  static async #getAssetInfo() {
    const apiUrl = 'https://api.github.com/repos/lanly-dev/play-buffer/releases/latest'
    const releaseInfo = await new Promise((resolve, reject) => {
      https.get(apiUrl, { headers: { 'User-Agent': 'akazas-love-extension' } }, (res) => {
        let data = ''
        res.on('data', chunk => data += chunk)
        res.on('end', () => {
          try { resolve(JSON.parse(data)) }
          catch (e) { reject(e) }
        })
      }).on('error', reject)
    })
    const asset = releaseInfo.assets.find(a => a.name === Speaker.#assetName)
    if (!asset) throw new Error('No compatible binary')
    return asset
  }
}

module.exports = Speaker
