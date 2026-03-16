const fs = require('fs')
const path = require('path')
const https = require('https')
const vscode = require('vscode')

const SAMPLE_RATE = 44100
const MIDI_MIN = 21   // A0
const MIDI_MAX = 108  // C8

// The gleitz repo serves all notes for an instrument as a single JS file.
// The file is a JS object assignment like:
//   if (typeof(MIDI) === 'undefined') var MIDI = {};
//   if (typeof(MIDI.Soundfont) === 'undefined') MIDI.Soundfont = {};
//   MIDI.Soundfont.acoustic_grand_piano = {
//     "A0": "data:audio/mp3;base64,<base64data>",
//     "Bb0": "data:audio/mp3;base64,<base64data>",
//     ...
//   }
// We fetch this file, regex out the note->base64 pairs, and decode each MP3.
const SOUNDFONT_JS_URL = 'https://raw.githubusercontent.com/gleitz/midi-js-soundfonts/gh-pages/FluidR3_GM/acoustic_grand_piano-mp3.js'
const CACHE_FILENAME = 'acoustic_grand_piano-mp3.js'

// Gleitz uses flats not sharps in note names
const NOTE_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B']

function midiToNoteName(midi) {
  const octave = Math.floor(midi / 12) - 1
  return `${NOTE_NAMES[midi % 12]}${octave}`
}

class SoundFont {
  static #cacheDir = null
  static #samples = new Map()   // midi number -> Float32Array (mono, 44100 Hz)
  static #ready = false
  static #initPromise = null

  static get isReady() { return this.#ready }

  static init(context) {
    if (this.#initPromise) return this.#initPromise
    this.#cacheDir = path.join(context.globalStoragePath, 'soundfont')
    fs.mkdirSync(this.#cacheDir, { recursive: true })
    this.#initPromise = this.#run(context)
    return this.#initPromise
  }

  static async waitUntilReady() {
    if (this.#ready) return
    if (!this.#initPromise) throw new Error('SoundFont.init() was not called')
    const msg = vscode.window.setStatusBarMessage('🎹 Waiting for piano samples...')
    try {
      await this.#initPromise
    } finally {
      msg.dispose()
    }
  }

  static getSample(midiNote, durationSecs, velocity = 0.8) {
    if (!this.#ready) throw new Error('SoundFont not ready — call waitUntilReady() first')
    const clamped = Math.max(MIDI_MIN, Math.min(MIDI_MAX, midiNote))
    const raw = this.#samples.get(clamped)
    if (!raw) throw new Error(`No sample for midi note ${clamped}`)

    const needed = Math.max(1, Math.ceil(durationSecs * SAMPLE_RATE))
    const output = new Float32Array(needed)
    const releaseSamples = Math.min(needed, Math.floor(0.12 * SAMPLE_RATE))

    for (let i = 0; i < needed; i++) {
      const s = i < raw.length ? raw[i] : 0
      const fade = (needed - i) < releaseSamples ? (needed - i) / releaseSamples : 1.0
      output[i] = s * velocity * fade
    }
    return output
  }

  // ── Private ────────────────────────────────────────────────────────────────

  static async #run(context) {
    const cacheFile = path.join(this.#cacheDir, CACHE_FILENAME)

    // Download the JS file if not already cached
    if (!fs.existsSync(cacheFile)) {
      const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99)
      statusItem.text = '🎹 Downloading piano soundfont…'
      statusItem.tooltip = 'Downloading soundfont for Akaza\'s Love (one-time)'
      statusItem.show()
      context.subscriptions.push(statusItem)
      try {
        await this.#downloadFile(SOUNDFONT_JS_URL, cacheFile)
        statusItem.text = '🎹 Decoding piano samples…'
      } catch (e) {
        statusItem.text = '⚠️ Soundfont download failed'
        console.error('SoundFont download failed:', e)
        return
      } finally {
        setTimeout(() => statusItem.hide(), 4000)
      }
    }

    await this.#decodeFromJsFile(cacheFile, context)
    this.#ready = true
    vscode.window.setStatusBarMessage('🎹 Piano samples ready!', 3000)
  }

  static async #decodeFromJsFile(jsFilePath, context) {
    const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99)
    statusItem.text = '🎹 Decoding piano samples…'
    statusItem.show()
    context.subscriptions.push(statusItem)

    const js = fs.readFileSync(jsFilePath, 'utf8')

    // Extract all "NoteName": "data:audio/mp3;base64,<data>" pairs
    // Example match: "A4": "data:audio/mp3;base64,//uQx..."
    const noteRegex = /"([A-Gb#\d]+)":\s*"data:audio\/mp3;base64,([^"]+)"/g
    const noteMap = new Map()  // noteName -> base64 string
    let match
    while ((match = noteRegex.exec(js)) !== null) {
      noteMap.set(match[1], match[2])
    }

    if (noteMap.size === 0) {
      console.error('SoundFont: no notes found in JS file — format may have changed')
      statusItem.hide()
      return
    }

    console.log(`SoundFont: found ${noteMap.size} notes in soundfont file`)

    const { MPEGDecoder } = require('mpg123-decoder')
    let decoded = 0

    for (let midi = MIDI_MIN; midi <= MIDI_MAX; midi++) {
      const noteName = midiToNoteName(midi)
      const b64 = noteMap.get(noteName)
      if (!b64) {
        console.warn(`SoundFont: no sample for ${noteName} (midi ${midi})`)
        continue
      }

      // Each note gets its own decoder instance to avoid stream state bleed
      const decoder = new MPEGDecoder()
      await decoder.ready
      try {
        const mp3Buffer = Buffer.from(b64, 'base64')
        const { channelData, sampleRate } = await decoder.decode(mp3Buffer)
        const mono = this.#toMono(channelData)
        this.#samples.set(midi, sampleRate === SAMPLE_RATE ? mono : this.#resample(mono, sampleRate, SAMPLE_RATE))
      } catch (e) {
        console.error(`SoundFont: failed to decode ${noteName}:`, e)
      } finally {
        decoder.free()
      }

      decoded++
      if (decoded % 10 === 0) {
        const pct = Math.round((decoded / (MIDI_MAX - MIDI_MIN + 1)) * 100)
        statusItem.text = `🎹 Decoding piano samples… ${pct}%`
      }
    }

    statusItem.hide()
  }

  static #downloadFile(url, destPath) {
    return new Promise((resolve, reject) => {
      const tmp = destPath + '.tmp'
      const file = fs.createWriteStream(tmp)
      https.get(url, { headers: { 'User-Agent': 'akazas-love-vscode-extension' } }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          file.destroy()
          fs.unlink(tmp, () => {})
          return this.#downloadFile(res.headers.location, destPath).then(resolve).catch(reject)
        }
        if (res.statusCode !== 200) {
          file.destroy()
          fs.unlink(tmp, () => {})
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`))
        }
        res.pipe(file)
        file.on('finish', () => {
          file.close(() => {
            fs.rename(tmp, destPath, err => err ? reject(err) : resolve())
          })
        })
        file.on('error', e => { fs.unlink(tmp, () => {}); reject(e) })
      }).on('error', e => { fs.unlink(tmp, () => {}); reject(e) })
    })
  }

  static #toMono(channelData) {
    if (channelData.length === 1) return channelData[0]
    const L = channelData[0], R = channelData[1]
    const mono = new Float32Array(L.length)
    for (let i = 0; i < L.length; i++) mono[i] = (L[i] + R[i]) * 0.5
    return mono
  }

  static #resample(input, fromRate, toRate) {
    if (fromRate === toRate) return input
    const ratio = fromRate / toRate
    const outLen = Math.floor(input.length / ratio)
    const out = new Float32Array(outLen)
    for (let i = 0; i < outLen; i++) {
      const src = i * ratio
      const lo = Math.floor(src), hi = Math.min(lo + 1, input.length - 1)
      out[i] = input[lo] + (src - lo) * (input[hi] - input[lo])
    }
    return out
  }
}

module.exports = SoundFont
