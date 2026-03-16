const { https } = require('follow-redirects')
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const vscode = require('vscode')

class Speaker {

  static #PLAY_BUFFER_MODE = '--stream-callback'

  static #binaryPath = null
  static #binaryReady = false
  static #binaryDownloading = false

  // Store the last playProcess for stopping
  static #currentPlayProcess = null

  // Round-robin pool of up to 100 persistent play-buffer stream processes
  static #streamPool = []
  static #streamPoolIdx = 0
  static #MAX_STREAMS = 100

  static async setupSpeaker(context, statusBarItem) {
    if (!this.#assetName) {
      vscode.window.showErrorMessage('Unsupported platform for play-buffer')
      return
    }
    try {
      if (!Speaker.#binaryReady) await Speaker.#downloadPlayBuffer(context)
      Speaker.startPersistentProcesses(statusBarItem)
    } catch (e) {
      console.error('Failed to setup Speaker:', e)
    }
  }

  static startPersistentProcesses(statusBarItem) {
    try {
      if (Speaker.#streamPool.length < Speaker.#MAX_STREAMS) {
        for (let i = Speaker.#streamPool.length; i < Speaker.#MAX_STREAMS; i++) {
          const proc = spawn(Speaker.#binaryPath, [Speaker.#PLAY_BUFFER_MODE], { stdio: ['pipe', 'ignore', 'ignore'] })
          proc.on('error', (err) => {
            console.error('play-buffer pool process error:', err)
            Speaker.#streamPool[i] = null
          })
          proc.on('exit', () => {
            console.info('play-buffer pool process exited')
            Speaker.#streamPool[i] = null
          })
          Speaker.#streamPool.push(proc)
        }
        // Add a delay before marking ready
        setTimeout(() => {
          statusBarItem.text = 'Akaza: Ready ❄️'
          statusBarItem.tooltip = 'Akaza extension is ready!'
        }, 2000) // 2 second delay
      }
    } catch (err2) {
      console.error('Failed to start play-buffer process:', err2)
      vscode.window.showWarningMessage('Failed to start play-buffer process: ' + err2.message)
    }
  }

  static stopAllProcesses() {
    try {
      // Kill all stream pool processes
      for (let proc of Speaker.#streamPool) {
        if (proc && !proc.killed) {
          proc.stdin.end()
          proc.kill()
        }
      }
      Speaker.#streamPool = []
      Speaker.#streamPoolIdx = 0

      Speaker.#killCurrentProcess()
    } catch (e) {
      console.error('Failed to stop play-buffer processes:', e)
    }
  }

  static sendToSpeaker(buffer, onFinish = null) {
    if (!Speaker.#binaryPath || !fs.existsSync(Speaker.#binaryPath)) {
      vscode.window.showErrorMessage('play-buffer binary not found or not downloaded')
      return
    }
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      vscode.window.showErrorMessage('PCM buffer is invalid or empty')
      console.warn('Speaker.sendToSpeaker: Invalid buffer', buffer)
      return
    }
    // PCM format checks (assume 16-bit signed, 44.1kHz, mono)
    // Optionally, warn if buffer length is suspiciously small
    const expectedSampleRate = 44100
    const expectedChannels = 1
    const expectedBitDepth = 16
    const isBufferTooShort = buffer.length < expectedSampleRate * expectedChannels * (expectedBitDepth / 8) * 0.1
    if (isBufferTooShort) console.warn('PCM buffer is very short (less than 0.1s)')

    try {
      // Kill any previous playProcess
      Speaker.#killCurrentProcess()
      // The method sendToSpeaker should be generic but well only one task calls it so it is fine
      vscode.commands.executeCommand('setContext', 'akazas-love.playing', true)

      const playProcess = spawn(Speaker.#binaryPath, [], { stdio: ['pipe', 'ignore', 'ignore'] })
      Speaker.#currentPlayProcess = playProcess
      playProcess.stdin.write(buffer)
      playProcess.stdin.end()
      playProcess.on('error', (err) => {
        vscode.window.showWarningMessage('Failed to play buffer: ' + err.message)
        console.error('Speaker.sendToSpeaker spawn error:', err)
      })
      playProcess.on('exit', (code, signal) => {
        Speaker.#currentPlayProcess = null
        vscode.commands.executeCommand('setContext', 'akazas-love.playing', false)
        // Only call onFinish if the process ended naturally (not killed by stopToSpeaker)
        if (signal == null && onFinish) onFinish()
      })
    } catch (err2) {
      vscode.window.showWarningMessage('Failed to play buffer: ' + err2.message)
      console.error('Speaker.sendToSpeaker catch error:', err2)
    }
  }

  // Stop the last playProcess started by sendToSpeaker
  static stopToSpeaker() {
    if (Speaker.#currentPlayProcess && !Speaker.#currentPlayProcess.killed) Speaker.#killCurrentProcess()
    else vscode.window.showInformationMessage('No active play process to stop')
  }

  // Error on binary is in used by something even after killed all processes
  static async redownloadPlayBuffer(context) {
    await Speaker.#downloadPlayBuffer(context, true)
  }

  static sendToMultipleStreamsSpeaker(buffer) {
    // Send buffer to next process in pool (round robin)
    let proc = Speaker.#streamPool[Speaker.#streamPoolIdx % Speaker.#MAX_STREAMS]
    if (!proc || proc.killed) {
      // Restart dead process
      try {
        proc = spawn(Speaker.#binaryPath, [Speaker.#PLAY_BUFFER_MODE], { stdio: ['pipe', 'ignore', 'ignore'] })
        proc.on('error', (err) => {
          console.error('play-buffer pool process error:', err)
        })
        proc.on('exit', () => {
          Speaker.#streamPool[Speaker.#streamPoolIdx % Speaker.#MAX_STREAMS] = null
        })
        Speaker.#streamPool[Speaker.#streamPoolIdx % Speaker.#MAX_STREAMS] = proc
      } catch (e) {
        console.error('Failed to restart pool process:', e)
        return
      }
    }
    try {
      proc.stdin.write(buffer)
    } catch (e) {
      console.error('Speaker.sendToMultipleStreamsSpeaker write error:', e)
    }
    Speaker.#streamPoolIdx = (Speaker.#streamPoolIdx + 1) % Speaker.#MAX_STREAMS
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
        Speaker.#binaryDownloading = false
        // The binary is already downloaded
        return
      }
    }

    // Download the asset (auto-follows redirects)
    Speaker.#binaryDownloading = true
    const asset = await this.#getAssetInfo()
    await new Promise((resolve, reject) => {
      https.get(asset.browser_download_url, (response) => {
        if (response.statusCode !== 200) {
          let errorBody = ''
          response.on('data', chunk => errorBody += chunk)
          response.on('end', () => {
            vscode.window.showWarningMessage('Failed to download play-buffer binary: ' + response.statusCode)
            console.error('Download error body:', errorBody)
            Speaker.#binaryDownloading = false
            reject(new Error('Download failed: ' + response.statusCode))
          })
          return
        }
        const contentType = response.headers['content-type'] || ''
        // Accept typical binary content types; GitHub may omit or vary
        const isBinary = contentType.includes('octet-stream') || contentType.includes('binary') || contentType === ''
        if (!isBinary) {
          let errorBody = ''
          response.on('data', chunk => errorBody += chunk)
          response.on('end', () => {
            vscode.window.showErrorMessage('Downloaded file is not a binary. Content-Type: ' + contentType)
            console.error('Non-binary download body:', errorBody)
            Speaker.#binaryDownloading = false
            reject(new Error('Non-binary file: ' + contentType))
          })
          return
        }
        const file = fs.createWriteStream(Speaker.#binaryPath)
        response.pipe(file)
        file.on('finish', () => {
          file.close()
          try {
            if (process.platform !== 'win32') fs.chmodSync(Speaker.binaryPath, '755')
          } catch (e) {
            console.error('Failed to set executable permission:', e)
          }
          Speaker.#binaryReady = true
          Speaker.#binaryDownloading = false
          vscode.window.showInformationMessage('Downloaded play-buffer binary successfully! 🚀')
          resolve()
        })
        file.on('error', (err) => {
          Speaker.#binaryDownloading = false
          reject(err)
        })
      }).on('error', (err) => {
        Speaker.#binaryDownloading = false
        reject(err)
      })
    })
  }

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

  static async #getAssetInfo() {
    // Fetch latest release info from GitHub API
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

    // Find correct asset for platform
    const asset = releaseInfo.assets.find(a => a.name === Speaker.#assetName)
    if (!asset) throw new Error('No compatible binary')
    return asset
  }
}

module.exports = Speaker
