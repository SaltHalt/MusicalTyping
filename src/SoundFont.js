const fs = require('fs')
const path = require('path')
const https = require('https')

// SoundFont is vscode-free. Callers inject status callbacks so this module
// works identically in the VSCode extension and Electron standalone.

const SAMPLE_RATE = 44100
const MIDI_MIN = 21   // A0
const MIDI_MAX = 108  // C8

const SOUNDFONT_JS_URL = 'https://raw.githubusercontent.com/gleitz/midi-js-soundfonts/gh-pages/FluidR3_GM/acoustic_grand_piano-mp3.js'
const CACHE_FILENAME = 'acoustic_grand_piano-mp3.js'

// Gleitz uses flats not sharps: Db, Eb, Gb, Ab, Bb
const NOTE_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B']
const midiToNoteName = midi => `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`

class SoundFont {
  static #cacheDir = null
  static #samples = new Map()  // midi number -> Float32Array (mono, 44100 Hz)
  static #ready = false
  static #initPromise = null

  // Injected callbacks — default to console
  static #onStatus   = (msg) => console.log('[SoundFont]', msg)
  static #onProgress = (pct) => console.log(`[SoundFont] decoding ${pct}%`)

  static get isReady() { return this.#ready }

  /**
   * @param {string}   cacheDir             - writable dir for the soundfont file and decoded samples
   * @param {object}   [callbacks]
   * @param {function} [callbacks.onStatus]   - (message: string) => void  — shown in status bar / tray tooltip
   * @param {function} [callbacks.onProgress] - (percent: number) => void  — 0–100 during decode
   */
  static init(cacheDir, { onStatus, onProgress } = {}) {
    if (onStatus)   this.#onStatus   = onStatus
    if (onProgress) this.#onProgress = onProgress

    if (this.#initPromise) return this.#initPromise
    this.#cacheDir = path.join(cacheDir, 'soundfont')
    fs.mkdirSync(this.#cacheDir, { recursive: true })
    this.#initPromise = this.#run()
    return this.#initPromise
  }

  static async waitUntilReady() {
    if (this.#ready) return
    if (!this.#initPromise) throw new Error('SoundFont.init() was not called')
    this.#onStatus('🎹 Waiting for piano samples…')
    await this.#initPromise
  }

  // Returns a Float32Array of `durationSecs` seconds of PCM for the given midi note.
  static getSample(midiNote, durationSecs, velocity) {
    if (!this.#ready) throw new Error('SoundFont not ready')
    const clamped = Math.max(MIDI_MIN, Math.min(MIDI_MAX, midiNote))
    const raw = this.#samples.get(clamped)
    if (!raw) throw new Error(`No sample for midi ${clamped}`)

    const needed = Math.max(1, Math.ceil(durationSecs * SAMPLE_RATE))
    const out = new Float32Array(needed)
    const releaseSamples = Math.min(needed, Math.floor(0.12 * SAMPLE_RATE))
    for (let i = 0; i < needed; i++) {
      const fade = (needed - i) < releaseSamples ? (needed - i) / releaseSamples : 1.0
      out[i] = (i < raw.length ? raw[i] : 0) * velocity * fade
    }
    return out
  }

  static async #run() {
    const cacheFile = path.join(this.#cacheDir, CACHE_FILENAME)
    if (!fs.existsSync(cacheFile)) {
      this.#onStatus('🎹 Downloading piano soundfont…')
      try {
        await this.#downloadFile(SOUNDFONT_JS_URL, cacheFile)
      } catch (e) {
        this.#onStatus('⚠️ Soundfont download failed')
        console.error('SoundFont download failed:', e)
        return
      }
    }
    await this.#decode(cacheFile)
    this.#ready = true
    this.#onStatus('🎹 Piano samples ready!')
  }

  static async #decode(jsFilePath) {
    this.#onStatus('🎹 Decoding piano samples…')

    const js = fs.readFileSync(jsFilePath, 'utf8')
    const noteMap = new Map()
    const re = /"([A-Gb#\d]+)":\s*"data:audio\/mp3;base64,([^"]+)"/g
    let m
    while ((m = re.exec(js)) !== null) noteMap.set(m[1], m[2])

    if (noteMap.size === 0) {
      console.error('SoundFont: no notes found — format may have changed')
      return
    }

    const { MPEGDecoder } = require('mpg123-decoder')
    let done = 0
    const total = MIDI_MAX - MIDI_MIN + 1

    for (let midi = MIDI_MIN; midi <= MIDI_MAX; midi++) {
      const b64 = noteMap.get(midiToNoteName(midi))
      if (!b64) continue
      const decoder = new MPEGDecoder()
      await decoder.ready
      try {
        const { channelData, sampleRate } = await decoder.decode(Buffer.from(b64, 'base64'))
        const mono = channelData.length === 1 ? channelData[0]
          : channelData[0].map((s, i) => (s + channelData[1][i]) * 0.5)
        this.#samples.set(midi, sampleRate === SAMPLE_RATE ? mono : this.#resample(mono, sampleRate, SAMPLE_RATE))
      } catch (e) {
        console.error(`SoundFont: failed to decode midi ${midi}:`, e)
      } finally {
        decoder.free()
      }
      done++
      if (done % 10 === 0) this.#onProgress(Math.round(done / total * 100))
    }
  }

  static #downloadFile(url, destPath) {
    return new Promise((resolve, reject) => {
      const tmp = destPath + '.tmp'
      const file = fs.createWriteStream(tmp)
      https.get(url, { headers: { 'User-Agent': 'akazas-love-vscode-extension' } }, res => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          file.destroy()
          fs.unlink(tmp, () => {})
          return this.#downloadFile(res.headers.location, destPath).then(resolve).catch(reject)
        }
        if (res.statusCode !== 200) {
          file.destroy(); fs.unlink(tmp, () => {})
          return reject(new Error(`HTTP ${res.statusCode}`))
        }
        res.pipe(file)
        file.on('finish', () => file.close(() =>
          fs.rename(tmp, destPath, e => e ? reject(e) : resolve())))
        file.on('error', e => { fs.unlink(tmp, () => {}); reject(e) })
      }).on('error', e => { fs.unlink(tmp, () => {}); reject(e) })
    })
  }

  static #resample(input, fromRate, toRate) {
    const ratio = fromRate / toRate
    const out = new Float32Array(Math.floor(input.length / ratio))
    for (let i = 0; i < out.length; i++) {
      const src = i * ratio, lo = Math.floor(src), hi = Math.min(lo + 1, input.length - 1)
      out[i] = input[lo] + (src - lo) * (input[hi] - input[lo])
    }
    return out
  }
}

module.exports = SoundFont
