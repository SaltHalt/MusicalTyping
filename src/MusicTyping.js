const { Midi } = require('@tonejs/midi')
const { xzSync, unxzSync } = require('node-liblzma')
const fs = require('fs')
const path = require('path')
const v8 = require('v8')
const Speaker = require('./Speaker')
const SoundFont = require('./SoundFont')
//const Logger = require('./Logger')

const SAMPLE_RATE = 44100
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

// Shape of the config object returned by getConfig():
// {
//   musicTyping: boolean  — whether typing-driven notes are enabled
//   volume:      number   — 0.0–1.0
//   shuffle:     boolean
//   loop:        boolean
//   windowSize:  number   — seconds of notes to play per keypress
//   maxDelay:    number   — max scheduling backlog in seconds
// }
//
// Static/init-time only (not live):
//   mediaDir:  string    — folder containing .mid files
//   cacheDir:  string    — writable folder for pcm cache
//   binDir:    string    — folder containing play-buffer binary

class MusicTyping {
  static #keyCounter = 0

  // Fallback defaults — overridden immediately by init()
  static #staticConfig = {
    mediaDir: '',
    cacheDir: '',
    binDir:   '',
  }

  // Called every time a runtime value is needed (keypress, song advance)
  // Injected via init(); defaults to returning safe no-op values
  static #getConfig = () => ({
    musicTyping: true,
    volume:      0.1,
    shuffle:     false,
    loop:        true,
    windowSize:  0.2,
    maxDelay:    3,
  })

  static #cacheDir = null
  static #pcms = []
  static #currentNoteIdx = 0
  static #lastNoteRealTime = performance.now() / 1000
  static #lastNoteLogicTime = 0

  static #songList = []
  static #currentSongIdx = 0
  static #isPlaying = false
  static #playStartTime = null
  static #totalDuration = null //TODO: Needed?

  static #midiDuration = 0

  static #onSongChange = null

  // ── Init ───────────────────────────────────────────────────────────────────

  /**
   * @param {object} opts
   * @param {string}   opts.mediaDir      - folder containing .mid files
   * @param {string}   opts.cacheDir      - writable folder for pcm/soundfont cache
   * @param {string}   opts.binDir        - folder containing play-buffer binary
   * @param {function} opts.getConfig     - () => { musicTyping, volume, shuffle, loop, windowSize, maxDelay }
   *                                        called on every keypress and every song advance — return fresh values
   * @param {function} [opts.onSongChange] - called whenever song state changes (for UI updates)
   */
  static async init({ mediaDir, cacheDir, binDir, getConfig, onSongChange }) {
    this.#staticConfig = { mediaDir, cacheDir, binDir }
    if (getConfig) this.#getConfig = getConfig
    this.#cacheDir = path.join(cacheDir, 'midi_cache')
    this.#onSongChange = onSongChange ?? null
    fs.mkdirSync(this.#cacheDir, { recursive: true })

    await Speaker.setupSpeaker(binDir)
    SoundFont.init(cacheDir)

    this.#scanSongList()
    this.#currentSongIdx = Math.floor(Math.random() * this.#songList.length)

    await SoundFont.waitUntilReady()
    this.#loadCurrentMidi()
  }

  // ── Song list ──────────────────────────────────────────────────────────────

  static #scanSongList() {
    try {
      this.#songList = fs.readdirSync(this.#staticConfig.mediaDir)
        .filter(f => f.toLowerCase().endsWith('.mid'))
        .map(f => ({ name: path.basename(f, '.mid'), path: path.join(this.#staticConfig.mediaDir, f) }))
    } catch (e) {
      console.error('Failed to scan mediaDir for MIDI files:', e.message)
    }
    console.log(`Found ${this.#songList.length} MIDI file(s)`)
  }

  static #loadCurrentMidi() {
    if (this.#songList.length === 0) return
    const midiPath = this.#songList[this.#currentSongIdx].path
    const baseName = path.basename(midiPath, path.extname(midiPath))
    const cacheFile = path.join(this.#cacheDir, baseName + '.pcms')

    if (fs.existsSync(cacheFile)) {
      const compressed = fs.readFileSync(cacheFile)
      const buf = unxzSync(compressed)
      const { duration, pcms } = v8.deserialize(buf)
      this.#midiDuration = duration
      this.#pcms = pcms
      console.log(`Loaded cache: ${this.#midiDuration.toFixed(1)}s, ${(buf.length / 1e6).toFixed(1)} MB`)
    } else {
      console.log(`Rendering ${baseName}…`)
      const midi = new Midi(fs.readFileSync(midiPath))
      const notes = this.#extractNotes(midi)
      this.#pcms = this.#preRenderNotes(notes)
      this.#midiDuration = midi.duration

      const buf = v8.serialize({ duration: this.#midiDuration, pcms: this.#pcms })
      const compressed = xzSync(buf, { preset: 9 })
      fs.writeFileSync(cacheFile, compressed)

      const pcmSize = this.#pcms.reduce((acc, pcm) => acc + pcm.pcm.byteLength, 0)
      console.log(`Rendered: ${midi.tracks.length} tracks, ${notes.length} notes, ${this.#midiDuration.toFixed(1)}s, ${(pcmSize / 1e6).toFixed(1)} MB`)
    }
    this.#onSongChange?.()
  }

  static #advanceToNextSong() {
    if (this.#songList.length <= 1) return
    // Read shuffle live — user may have toggled it since last song
    const { shuffle } = this.#getConfig()
    this.#currentSongIdx = shuffle
      ? (() => { let n; do { n = Math.floor(Math.random() * this.#songList.length) } while (n === this.#currentSongIdx); return n })()
      : (this.#currentSongIdx + 1) % this.#songList.length
    this.#currentNoteIdx = 0
    this.#loadCurrentMidi()
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  static getSongList() {
    const { shuffle, loop } = this.#getConfig()
    return {
      songs: this.#songList.map(s => s.name),
      currentIdx: this.#currentSongIdx,
      shuffle,
      loop,
      isPlaying: this.#isPlaying,
      elapsed: (this.#isPlaying && this.#playStartTime) ? (Date.now() - this.#playStartTime) / 1000 : null,
      totalDuration: this.#totalDuration,
      midiProgress: this.#pcms.length ? this.#currentNoteIdx / this.#pcms.length : 0,
      midiDuration: this.#midiDuration,
    }
  }

  static selectSong(idx) {
    if (idx < 0 || idx >= this.#songList.length) return
    const wasPlaying = this.#isPlaying
    if (wasPlaying) Speaker.stopToSpeaker()
    this.#currentSongIdx = idx
    this.#currentNoteIdx = 0
    this.#lastNoteLogicTime = 0
    this.#lastNoteRealTime = performance.now() / 1000
    this.#loadCurrentMidi()
    if (wasPlaying) this.playMidiFile(true)
  }

  // These are called by the webview UI for both VSCode and standalone.
  // In VSCode they write back to workspace config; in standalone the Electron
  // main process updates the live config object — either way getConfig() picks
  // up the new value on the next call, so no extra wiring needed here.
  static setLoop(v)    { this.#onSongChange?.() }
  static setShuffle(v) { this.#onSongChange?.() }

  static async playMidiFile(needPlay) {
    if (!needPlay) {
      this.#isPlaying = false
      this.#playStartTime = null
      this.#totalDuration = null
      Speaker.stopToSpeaker()
      this.#onSongChange?.()
      return
    }
    if (!this.#songList.length) { console.warn('No MIDI files found in mediaDir'); return }
    await SoundFont.waitUntilReady()
    // Read volume live at play time
    const { volume, loop, shuffle } = this.#getConfig()
    const buffer = this.#mixNotes(this.#pcms).map(x => x * volume).map(Math.tanh)
    this.#totalDuration = buffer.length / SAMPLE_RATE
    this.#playStartTime = Date.now()
    this.#isPlaying = true
    this.#onSongChange?.()

    Speaker.sendToSpeaker(buffer, () => {
      this.#isPlaying = false
      this.#playStartTime = null
      this.#totalDuration = null
      // Re-read loop/shuffle at song boundary
      const cfg = this.#getConfig()
      if (cfg.loop || cfg.shuffle) { this.#advanceToNextSong(); this.playMidiFile(true) }
      else this.#onSongChange?.()
    })
  }

  // ── Note extraction ────────────────────────────────────────────────────────

  static #extractNotes(midi) {
    const midiTracks = midi.tracks.filter(track => track.notes.length > 0)
    let allNotes = []
    for (const track of midiTracks) {
      for (const note of track.notes) {
        note.instrument = track.instrument.number
        allNotes.push(note)
      }
    }
    allNotes.sort((a, b) => a.time - b.time)
    return allNotes
  }

  // ── Note rendering ─────────────────────────────────────────────────────────

  static #renderNote(note) {
    return SoundFont.getSample(note.midi, Math.max(note.duration, 0.05), Math.min(1.0, note.velocity))
  }

  static #renderGroup(notes) {
    const groupStartSample = Math.floor(notes[0].time * SAMPLE_RATE)
    const groupDuration = Math.max(...notes.map(n => n.time + n.duration))
    const totalSamples = Math.floor(SAMPLE_RATE * groupDuration) - groupStartSample + 1
    const mix = new Float32Array(totalSamples)
    for (const note of notes) {
      const pcm = this.#renderNote(note)
      const start = Math.floor(note.time * SAMPLE_RATE) - groupStartSample
      for (let i = 0; i < pcm.length && start + i < totalSamples; i++) mix[start + i] += pcm[i]
    }
    return mix
  }

  static #mixNotes(pcms) {
    const precedingSamples = Math.floor(pcms[0].time * SAMPLE_RATE)
    const sampleCount = Math.max(...pcms.map(p => Math.floor(p.time * SAMPLE_RATE) + p.pcm.length)) - precedingSamples
    const out = new Float32Array(sampleCount)
    for (const p of pcms) {
      const offset = Math.floor(p.time * SAMPLE_RATE) - precedingSamples
      for (let i = 0; i < p.pcm.length; i++) out[offset + i] += p.pcm[i]
    }
    return out
  }

  static #preRenderNotes(notes) {
    const renderedNotes = []
    for (let i = 0; i < notes.length; i++) {
      const group = { time: notes[i].time }
      const startI = i
      while (i + 1 < notes.length && notes[i + 1].time <= group.time) i++
      group.pcm = this.#renderGroup(notes.slice(startI, i + 1))
      renderedNotes.push(group)
    }
    return renderedNotes
  }

  // ── Typing/click playback ──────────────────────────────────────────────────

  // Call this on every keypress or mouse click
  static onKeyPress() {
    // Read musicTyping live — user may toggle it at any time
    if (!this.#getConfig().musicTyping) return
    this.#playMidiNotes()
  }

  static #playMidiNotes() {
    if (!this.#pcms?.length) return

    this.#keyCounter++
    if (this.#currentNoteIdx >= this.#pcms.length) {
      this.#currentNoteIdx = 0
      this.#advanceToNextSong()
      this.#onSongChange?.()
      return
    }

    // Read all runtime values fresh on every keypress
    const { windowSize, volume, maxDelay } = this.#getConfig()

    const currentNoteLogicTime = this.#pcms[this.#currentNoteIdx].time
    const lastNoteIdx = findLastNote(this.#pcms, this.#currentNoteIdx, currentNoteLogicTime + windowSize)
    const windowNotes = this.#pcms.slice(this.#currentNoteIdx, lastNoteIdx)
    const pcm = this.#mixNotes(windowNotes).map(x => x * volume).map(Math.tanh)

    const now = performance.now() / 1000
    const proposedRealTime = this.#lastNoteRealTime + (currentNoteLogicTime - this.#lastNoteLogicTime)
    const currentNoteRealTime = Math.max(now, proposedRealTime)
    const delay = currentNoteRealTime - now

    if (delay > maxDelay) return  // too much backlog, skip

    if (delay > 0) {
      setTimeout(() => Speaker.sendNoteToSpeaker(pcm), delay * 1000)
    } else {
      Speaker.sendNoteToSpeaker(pcm)
    }

    this.#currentNoteIdx = lastNoteIdx
    this.#lastNoteRealTime = currentNoteRealTime
    this.#lastNoteLogicTime = currentNoteLogicTime
    this.#onSongChange?.()

    function findLastNote(notes, startIdx, endTime) {
      let i = startIdx
      while (i < notes.length && notes[i].time <= endTime) i++
      return i
    }
  }

  static #midiToNoteName(midi) {
    return `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`
  }
}

module.exports = MusicTyping
