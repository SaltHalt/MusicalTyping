const { https } = require('follow-redirects')
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const vscode = require('vscode')

// ---------------------------------------------------------------------------
// Ring buffer constants
// ---------------------------------------------------------------------------
const SAMPLE_RATE = 44100
const CHUNK_SAMPLES = 512          // ~11ms per chunk — drain loop granularity
const RING_SAMPLES = SAMPLE_RATE * 4  // 4 seconds of ring buffer
const RING_BYTES = RING_SAMPLES * 4   // Float32 = 4 bytes per sample

// How far ahead of the read head we allow mixing (hard cap on queue depth).
// Keypresses beyond this are rejected by MusicTyping before calling mixNote().
const MAX_AHEAD_SAMPLES = SAMPLE_RATE  // 1 second

class Speaker {

  // ── Binary / setup ────────────────────────────────────────────────────────
  static #binaryPath = null
  static #binaryReady = false
  static #binaryDownloading = false

  // ── Streaming state ───────────────────────────────────────────────────────
  static #streamProc = null       // the persistent play-buffer --stream-callback process
  static #ringBuf = null          // Float32Array, length RING_SAMPLES
  static #writeHead = 0           // sample index: where the drain loop is currently reading
  static #mixHead = 0             // sample index: how far ahead notes have been mixed
  static #draining = false        // whether the drain pump is running
  static #streamReady = false     // true once the process is up

  // ── Full-song playback (separate process, stoppable) ─────────────────────
  static #currentPlayProcess = null

  // ── Public API ─────────────────────────────────────────────────────────────

  static async setupSpeaker(context, statusBarItem) {
    if (!this.#assetName) {
      vscode.window.showErrorMessage('Unsupported platform for play-buffer')
      return
    }
    try {
      if (!Speaker.#binaryReady) await Speaker.#downloadPlayBuffer(context)
      Speaker.#startStream()
      statusBarItem.text = 'Akaza: Ready ❄️'
      statusBarItem.tooltip = 'Akaza extension is ready!'
    } catch (e) {
      console.error('Failed to setup Speaker:', e)
    }
  }

  static stopAllProcesses() {
    try {
      Speaker.#stopStream()
      Speaker.#killCurrentProcess()
    } catch (e) {
      console.error('Failed to stop Speaker processes:', e)
    }
  }

  // Mix a note PCM buffer into the ring buffer at the correct time.
  // `aheadMs` is how many milliseconds from "now" (the current write head)
  // the note should start. Pass 0 for "play as soon as possible".
  // Returns false if the note would exceed the max queue depth (caller should drop it).
  static mixNote(floatBuffer, aheadMs = 0) {
    if (!Speaker.#streamReady || !Speaker.#ringBuf) return false

    const aheadSamples = Math.floor((aheadMs / 1000) * SAMPLE_RATE)
    const startSample = Speaker.#mixHead + aheadSamples

    // Reject if too far ahead
    if (startSample - Speaker.#writeHead > MAX_AHEAD_SAMPLES) {
      const overMs = ((startSample - Speaker.#writeHead - MAX_AHEAD_SAMPLES) / SAMPLE_RATE * 1000).toFixed(1)
      console.log(`[Speaker.mixNote] REJECTED: ${overMs}ms over limit, aheadMs=${aheadMs.toFixed(1)}, queueAheadMs=${Speaker.queueAheadMs.toFixed(1)}`)
      return false
    }

    // Mix (add) samples into the ring buffer
    for (let i = 0; i < floatBuffer.length; i++) {
      const ringIdx = (startSample + i) % RING_SAMPLES
      Speaker.#ringBuf[ringIdx] += floatBuffer[i]
      // Soft clip in place to prevent accumulation distortion
      if (Speaker.#ringBuf[ringIdx] > 1.0) Speaker.#ringBuf[ringIdx] = Math.tanh(Speaker.#ringBuf[ringIdx])
      else if (Speaker.#ringBuf[ringIdx] < -1.0) Speaker.#ringBuf[ringIdx] = Math.tanh(Speaker.#ringBuf[ringIdx])
    }

    // Advance mixHead to at least the end of this note
    const noteEnd = startSample + floatBuffer.length
    if (noteEnd > Speaker.#mixHead) Speaker.#mixHead = noteEnd

    console.log(`[Speaker.mixNote] mixed: aheadMs=${aheadMs.toFixed(1)} samples=${floatBuffer.length} queueNow=${Speaker.queueAheadMs.toFixed(1)}ms`)
    return true
  }

  // How many milliseconds of audio are currently queued ahead of the write head
  static get queueAheadMs() {
    if (!Speaker.#streamReady) return 0
    return ((Speaker.#mixHead - Speaker.#writeHead) / SAMPLE_RATE) * 1000
  }

  // For full-song playback (pre-rendered PCM, separate process)
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
      const playProcess = spawn(Speaker.#binaryPath, [], { stdio: ['pipe', 'ignore', 'ignore'] })
      Speaker.#currentPlayProcess = playProcess
      playProcess.stdin.write(buffer)
      playProcess.stdin.end()
      playProcess.on('error', err => {
        vscode.window.showWarningMessage('Failed to play buffer: ' + err.message)
      })
      playProcess.on('exit', (code, signal) => {
        Speaker.#currentPlayProcess = null
        vscode.commands.executeCommand('setContext', 'akazas-love.playing', false)
        if (signal == null && onFinish) onFinish()
      })
    } catch (err) {
      vscode.window.showWarningMessage('Failed to play buffer: ' + err.message)
    }
  }

  static stopToSpeaker() {
    if (Speaker.#currentPlayProcess && !Speaker.#currentPlayProcess.killed) Speaker.#killCurrentProcess()
    else vscode.window.showInformationMessage('No active play process to stop')
  }

  static async redownloadPlayBuffer(context) {
    await Speaker.#downloadPlayBuffer(context, true)
  }

  // ── Stream internals ───────────────────────────────────────────────────────

  static #startStream() {
    Speaker.#ringBuf = new Float32Array(RING_SAMPLES)
    Speaker.#writeHead = 0
    Speaker.#mixHead = 0
    Speaker.#draining = false
    Speaker.#streamReady = false

    const proc = spawn(Speaker.#binaryPath, ['--stream-callback'], {
      stdio: ['pipe', 'ignore', 'ignore']
    })
    Speaker.#streamProc = proc

    proc.on('error', err => console.error('play-buffer stream error:', err))
    proc.on('exit', (code, signal) => {
      console.warn(`play-buffer stream exited (code=${code} signal=${signal})`)
      Speaker.#streamReady = false
      Speaker.#draining = false
      // Restart unless we killed it intentionally
      if (signal !== 'SIGTERM' && signal !== 'SIGKILL') {
        setTimeout(() => Speaker.#startStream(), 500)
      }
    })

    // Give the process a moment to initialise its audio device before we
    // start pumping. Both heads start at the same position so queueAheadMs=0
    // and the first note plays immediately with no artificial offset.
    setTimeout(() => {
      Speaker.#streamReady = true
      Speaker.#writeHead = 0
      Speaker.#mixHead = 0
      Speaker.#startDrain()
    }, 200)
  }

  static #stopStream() {
    Speaker.#draining = false
    Speaker.#streamReady = false
    if (Speaker.#streamProc && !Speaker.#streamProc.killed) {
      try {
        Speaker.#streamProc.stdin.end()
        Speaker.#streamProc.kill()
      } catch (e) { /* ignore */ }
    }
    Speaker.#streamProc = null
    Speaker.#ringBuf = null
  }

  // The drain pump: reads CHUNK_SAMPLES from the ring buffer and writes to stdin.
  // Respects backpressure — if stdin.write returns false, waits for 'drain' event.
  // Uses setImmediate for tighter scheduling than setTimeout.
  static #startDrain() {
    if (Speaker.#draining) return
    Speaker.#draining = true
    Speaker.#pump()
  }

  static #pump() {
    if (!Speaker.#draining || !Speaker.#streamReady) return
    const proc = Speaker.#streamProc
    if (!proc || proc.killed || !proc.stdin.writable) return

    // Extract CHUNK_SAMPLES from ring buffer starting at writeHead
    const chunk = new Float32Array(CHUNK_SAMPLES)
    for (let i = 0; i < CHUNK_SAMPLES; i++) {
      const ringIdx = (Speaker.#writeHead + i) % RING_SAMPLES
      chunk[i] = Speaker.#ringBuf[ringIdx]
      // Clear the slot after reading so it's ready for future mixing
      Speaker.#ringBuf[ringIdx] = 0
    }
    Speaker.#writeHead += CHUNK_SAMPLES

    // Keep mixHead at least at writeHead so new notes don't go into the past
    if (Speaker.#mixHead < Speaker.#writeHead) Speaker.#mixHead = Speaker.#writeHead

    const nodeBuf = Buffer.from(chunk.buffer)
    const ok = proc.stdin.write(nodeBuf)

    if (ok) {
      // stdin buffer has room — schedule next chunk immediately
      setImmediate(() => Speaker.#pump())
    } else {
      // Backpressure: wait for stdin to drain before sending more
      proc.stdin.once('drain', () => Speaker.#pump())
    }
  }

  // ── Process / download helpers ─────────────────────────────────────────────

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
