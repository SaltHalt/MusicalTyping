const fs = require('fs')
const path = require('path')
const https = require('https')
const vscode = require('vscode')

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
    try { await this.#initPromise } finally { msg.dispose() }
  }

  // Returns a Float32Array of `durationSecs` seconds of PCM for the given midi note.
  static getSample(midiNote, durationSecs, velocity) {
    if (!this.#ready) throw new Error('SoundFont not ready')
    const clamped = Math.max(MIDI_MIN, Math.min(MIDI_MAX, midiNote))
    const raw = this.#samples.get(clamped)
    if (!raw) throw new Error(`No sample for midi ${clamped}`)

    const needed = Math.max(1, Math.ceil(durationSecs * SAMPLE_RATE))
    const out = new Float32Array(needed)
    const releaseSamples = Math.min(needed, Math.floor(0.12 * SAMPLE_RATE)) //Is this a normal fade?
    for (let i = 0; i < needed; i++) {
      const fade = (needed - i) < releaseSamples ? (needed - i) / releaseSamples : 1.0   //\log_{10}\left(1+9x\right)
      out[i] = (i < raw.length ? raw[i] : 0) * velocity * fade  //gain = \log_{10}\left(1+9*velocity\right)
    }
    return out
  }

  static async #run(context) {
    const cacheFile = path.join(this.#cacheDir, CACHE_FILENAME)
    if (!fs.existsSync(cacheFile)) {
      const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99)
      bar.text = '🎹 Downloading piano soundfont…'
      bar.show()
      context.subscriptions.push(bar)
      try {
        await this.#downloadFile(SOUNDFONT_JS_URL, cacheFile)
      } catch (e) {
        bar.text = '⚠️ Soundfont download failed'
        console.error('SoundFont download failed:', e)
        setTimeout(() => bar.hide(), 4000)
        return
      }
      bar.hide()
    }
    await this.#decode(cacheFile, context)
    this.#ready = true
    vscode.window.setStatusBarMessage('🎹 Piano samples ready!', 3000)
  }

  static async #decode(jsFilePath, context) { //TODO: no js library function?
    const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99)
    bar.text = '🎹 Decoding piano samples…'
    bar.show()
    context.subscriptions.push(bar)

    const js = fs.readFileSync(jsFilePath, 'utf8')
    const noteMap = new Map()
    const re = /"([A-Gb#\d]+)":\s*"data:audio\/mp3;base64,([^"]+)"/g
    let m
    while ((m = re.exec(js)) !== null) noteMap.set(m[1], m[2])

    if (noteMap.size === 0) {
      console.error('SoundFont: no notes found — format may have changed')
      bar.hide()
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
      if (done % 10 === 0) bar.text = `🎹 Decoding piano samples… ${Math.round(done / total * 100)}%`
    }
    bar.hide()
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
