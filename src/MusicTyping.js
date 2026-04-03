const { Midi } = require('@tonejs/midi')
const fs = require('fs')
const path = require('path')
const vscode = require('vscode')
const Speaker = require('./Speaker')
const SoundFont = require('./SoundFont')

const SAMPLE_RATE = 44100
const WINDOW_LENGTH_SECS = 1
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

class MusicTyping {

  static #context
  static #webviewProvider
  static #enabled
  static #volume

  static #notes = []           // flat array of notes sorted by start time
  static #currentNoteIdx = 0
  static #nextBlockStartTime = 0

  static #songList = []        // [{ name, path }]
  static #currentSongIdx = 0
  static #shuffle = false
  static #loop = true
  static #isPlaying = false
  static #playStartTime = null
  static #totalDuration = null

  static #MAX_QUEUE_MS = 1000
  static #midiDuration = 0
  static #queueEndMs = 0

  static stopBtn = null

  // ── Init ───────────────────────────────────────────────────────────────────

  static init(context, webviewProvider) {
    this.#context = context
    this.#webviewProvider = webviewProvider

    const config = vscode.workspace.getConfiguration('akazas-love')
    this.#enabled = config.get('musicTyping')
    this.#volume = config.get('volume')
    this.#shuffle = config.get('shuffle') ?? false
    this.#loop = config.get('loop') ?? true

    this.#scanSongList()
    this.#loadCurrentMidi()

    this.stopBtn = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
    this.stopBtn.command = 'akazas-love.stopSong'
    this.stopBtn.text = 'Stop'
    context.subscriptions.push(this.stopBtn)

    // Typing listener
    context.subscriptions.push(
      vscode.workspace.onDidChangeTextDocument(event => {
        if (!this.#enabled || !event.contentChanges.length) return
        const ch = event.contentChanges[0].text
        if (ch === '\n' || ch === '\r\n') return
        this.#playMidiNotes()
      }),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (!e.affectsConfiguration('akazas-love')) return
        const cfg = vscode.workspace.getConfiguration('akazas-love')
        this.#enabled = cfg.get('musicTyping')
        this.#volume = cfg.get('volume')
        this.#shuffle = cfg.get('shuffle') ?? false
        this.#loop = cfg.get('loop') ?? true
      }),
    )
  }

  // ── Song list ──────────────────────────────────────────────────────────────

  static #scanSongList() {
    const mediaDir = path.join(this.#context.extensionPath, 'media')
    try {
      this.#songList = fs.readdirSync(mediaDir)
        .filter(f => f.toLowerCase().endsWith('.mid'))
        .map(f => ({ name: path.basename(f, '.mid'), path: path.join(mediaDir, f) }))
    } catch (e) {
      console.error('Failed to scan media/ for MIDI files:', e)
    }
    console.log(`Found ${this.#songList.length} MIDI file(s)`)
  }

  static #loadCurrentMidi() {
    if (this.#songList.length === 0) return
    const midiPath = this.#songList[this.#currentSongIdx].path
    const midi = new Midi(fs.readFileSync(midiPath))

    const allNotes = []
    midi.tracks.forEach(track => 
      track.notes.forEach(note => // TODO: Squashing of tracks?
        allNotes.push({
          midi: note.midi,
          name: note.name,
          duration: note.duration,
          time: note.time,
          velocity: note.velocity * 1.5, //TODO: Should this be removed?
        })
      )
    )

    allNotes.sort((a, b) => a.time - b.time)
    this.#notes = allNotes

    this.#midiDuration = allNotes.length
      ? Math.max(...allNotes.map(n => n.time + n.duration))
      : 0
    console.log(`Loaded: ${midi.tracks.length} tracks, ${allNotes.length} notes, ${this.#midiDuration.toFixed(1)}s`)
  }

  static #advanceToNextSong() {
    if (this.#songList.length <= 1) return
    this.#currentSongIdx = this.#shuffle
      ? (() => { let n; do { n = Math.floor(Math.random() * this.#songList.length) } while (n === this.#currentSongIdx); return n })()
      : (this.#currentSongIdx + 1) % this.#songList.length
    this.#currentNoteIdx = 0
    this.#loadCurrentMidi()
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  static getSongList() {
    return {
      songs: this.#songList.map(s => s.name),
      currentIdx: this.#currentSongIdx,
      shuffle: this.#shuffle,
      loop: this.#loop,
      isPlaying: this.#isPlaying,
      elapsed: (this.#isPlaying && this.#playStartTime) ? (Date.now() - this.#playStartTime) / 1000 : null,
      totalDuration: this.#totalDuration,
      midiProgress: this.#notes.length ? this.#currentNoteIdx / this.#notes.length : 0,
      midiDuration: this.#midiDuration,
    }
  }

  static selectSong(idx) {
    if (idx < 0 || idx >= this.#songList.length) return
    const wasPlaying = this.#isPlaying
    if (wasPlaying) Speaker.stopToSpeaker()
    this.#currentSongIdx = idx
    this.#currentNoteIdx = 0
    this.#queueEndMs = 0
    this.#loadCurrentMidi()
    this.#webviewProvider?.postSongList()
    if (wasPlaying) this.playMidiFile(true)
  }

  static setLoop(v) { this.#loop = v; this.#webviewProvider?.postSongList() }
  static setShuffle(v) { this.#shuffle = v; this.#webviewProvider?.postSongList() }

  static async playMidiFile(needPlay) {
    if (!needPlay) {
      this.#isPlaying = false
      this.#playStartTime = null
      this.#totalDuration = null
      Speaker.stopToSpeaker()
      this.stopBtn.hide()
      this.#webviewProvider?.postSongList()
      return
    }
    if (!this.#songList.length) { vscode.window.showWarningMessage('No MIDI files found in media/'); return }
    await SoundFont.waitUntilReady()
    const buffer = await this.#renderMidiToBuffer(this.#songList[this.#currentSongIdx].path)
    this.#totalDuration = (buffer.length / 4) / SAMPLE_RATE
    this.#playStartTime = Date.now()
    this.#isPlaying = true
    this.#webviewProvider?.postSongList()
    Speaker.sendToSpeaker(buffer, () => {
      this.#isPlaying = false
      this.#playStartTime = null
      this.#totalDuration = null
      this.stopBtn.hide()
      vscode.commands.executeCommand('setContext', 'akazas-love.playing', false)
      if (this.#loop || this.#shuffle) { this.#advanceToNextSong(); this.playMidiFile(true) }
      else this.#webviewProvider?.postSongList()
    })
    this.stopBtn.show()
  }

  // ── Note rendering ─────────────────────────────────────────────────────────

  // Inline of MusicSynth.generateNote — returns Float32Array PCM for one note
  static #renderNote(midiNote, durationSecs, delayMs, options = {}) {
    const velocity = Math.min(1.0, options.velocity ?? 0.8)
    return SoundFont.getSample(midiNote, Math.max(durationSecs, 0.05), delayMs, velocity) //TODO: Why impose a ceiling on duration?
  }

  // Inline of MusicSynth.getMidiFileBuffer — mix all notes into one PCM buffer
  static async #renderMidiToBuffer(midiPath) {
    const midi = new Midi(fs.readFileSync(midiPath))
    const allNotes = []
    midi.tracks.forEach(t => t.notes.forEach(n => allNotes.push(n)))
    allNotes.sort((a, b) => a.time - b.time)

    const totalSamples = Math.ceil(SAMPLE_RATE * (Math.max(midi.duration, ...allNotes.map(n => n.time + n.duration)) + 0.5))
    const mix = new Float32Array(totalSamples)

    for (const note of allNotes) {
      const pcm = this.#renderNote(note.midi, note.duration, 0, { velocity: note.velocity }) //TODO: Doesn't consider instrument.
      const start = Math.floor(note.time * SAMPLE_RATE)
      for (let i = 0; i < pcm.length && start + i < totalSamples; i++) mix[start + i] += pcm[i]
    }
    for (let i = 0; i < totalSamples; i++) mix[i] = Math.tanh(mix[i]) //TODO: Tanh necessary?
    return Buffer.from(mix.buffer)
  }

  // ── Typing playback ────────────────────────────────────────────────────────

  static #playMidiNotes() {
    if (!this.#notes.length) return

    const now = performance.now()
    this.#queueEndMs = Math.max(this.#queueEndMs, now)
    const queueAheadMs = this.#queueEndMs - now

    const isQueueTooLong = queueAheadMs > this.#MAX_QUEUE_MS && queueAheadMs > 0
    if (isQueueTooLong) return

    const endOfMidiReached = this.#currentNoteIdx >= this.#notes.length
    if (endOfMidiReached) {
      this.#currentNoteIdx = 0
      this.#advanceToNextSong()
      this.#webviewProvider?.postSongList()
      return
    }

    const windowStart = this.#notes[this.#currentNoteIdx].time
    const windowEnd = windowStart + WINDOW_LENGTH_SECS

    let scanIdx = this.#currentNoteIdx
    const windowNotes = []
    while (scanIdx < this.#notes.length && this.#notes[scanIdx].time <= windowEnd)
      windowNotes.push(this.#notes[scanIdx++])
    if (!windowNotes.length) { windowNotes.push(this.#notes[this.#currentNoteIdx]); scanIdx++ }

    for (const note of windowNotes) {
      if (!SoundFont.isReady) break
      const delayMs = queueAheadMs + (note.time - windowStart) * 1000
      const pcm = Buffer.from(this.#renderNote(note.midi, Math.max(note.duration, 0.3), delayMs, {
        velocity: note.velocity * this.#volume,
      }).buffer)
      Speaker.sendNoteToSpeaker(pcm)
    }

    this.#queueEndMs = this.#queueEndMs + WINDOW_LENGTH_SECS * 1000
    this.#currentNoteIdx = scanIdx
    this.#webviewProvider?.postSongList()

    vscode.window.setStatusBarMessage(
      `🎵 ${windowNotes.map(n => n.name).join('+')}`, 1500)
  }

  static #midiToNoteName(midi) {
    return `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`
  }
}

module.exports = MusicTyping
