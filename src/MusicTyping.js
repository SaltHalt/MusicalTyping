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
  static #lastNoteRealTime
  static #lastNoteLogicTime
  static #maxDelay = 3

  static #songList = []        // [{ name, path }]
  static #currentSongIdx = 0
  static #shuffle = false
  static #loop = true
  static #isPlaying = false
  static #playStartTime = null
  static #totalDuration = null //TODO: Needed?

  static #midiDuration = 0

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
    const midi = this.#readMidiFile(midiPath)
    this.#notes = this.#extractNotes(midi)
    this.#midiDuration = midi.duration
    console.log(`Loaded: ${midi.tracks.length} tracks, ${this.#notes.length} notes, ${this.#midiDuration.toFixed(1)}s`)
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

  //Flattens and sorts notes by start time.
  static #readMidiFile(midiPath) {
    return new Midi(fs.readFileSync(midiPath))
  }
  static #extractNotes(midi){
    let allNotes = []
    midi.tracks.forEach(t => t.notes.forEach(n => allNotes.push(n)))
    allNotes.sort((a, b) => a.time - b.time)
    //TODO: Do i Need to worry about midi.header? 
    return allNotes
  }

  // ── Note rendering ─────────────────────────────────────────────────────────

  // Structure of midi note: t3 {midi: 67, velocity: 1, noteOffVelocity: 0, ticks: 9216, durationTicks: 764}
  // Structure of midi track: {
  // name: "",
  // notes: [      {        midi: 94,        velocity: 0.7480314960629921,        noteOffVelocity: 0,        ticks: 31392,        durationTicks: 48,      }, ...    ],
  // controlChanges: {
  //   "11": [ {          ticks: 31584,          value: 0.5905511811023622,        },
  //     {          ticks: 77664,          value: 0.5905511811023622,        },],
  //   "91": [        {          ticks: 31488,          value: 0.47244094488188976,        },        {          ticks: 77568,          value: 0.47244094488188976,        },      ], ...
  //   ],
  // },
  // pitchBends: [],
  // instrument: {number: 55, },
  // channel: 2,
  // endOfTrackTicks: undefined,}

  // Inline of MusicSynth.generateNote — returns Float32Array PCM for one note
  static #renderNote(note, delay) {
    return SoundFont.getSample(note.midi, Math.max(note.duration, 0.05), Math.min(1.0, note.velocity)) //Should I add this.#volume here?
  }


  // notes must be in order
  static #renderGroup(notes) {
    const group_start_sample = Math.floor(notes[0].time * SAMPLE_RATE)
    const group_duration = Math.max(...notes.map(n => n.time + n.duration))
    const totalSamples = Math.ceil(SAMPLE_RATE * group_duration) + 1
    const mix = new Float32Array(totalSamples)

    for (const note of notes) {
      const pcm = this.#renderNote(note, 0) //TODO: Doesn't consider instrument.
      const start = Math.floor((note.time) * SAMPLE_RATE) - group_start_sample
      for (let i = 0; i < pcm.length && start + i < totalSamples; i++) mix[start + i] += pcm[i]
    }
    for (let i = 0; i < totalSamples; i++) mix[i] = Math.tanh(mix[i])
    return mix
  }

  // Sticks silence before the pcm
  static #prependSilence(pcm, duration) {
    const silenceLength = Math.ceil(duration * SAMPLE_RATE)
    const delayed_pcm = new Float32Array(silenceLength + pcm.length)
    for (let i = 0; i < pcm.length; i++) {
      delayed_pcm[silenceLength + i] = pcm[i]
    }
    return delayed_pcm
  }

  // Inline of MusicSynth.getMidiFileBuffer — mix all notes into one PCM buffer
  static async #renderMidiToBuffer(midiPath) {
    const midi = this.#readMidiFile(midiPath)
    const allNotes = this.#extractNotes(midi)
    return this.#renderGroup(allNotes)
  }

  // ── Typing playback ────────────────────────────────────────────────────────

  static #playMidiNotes() {
    // const now = performance.now()
    // this.#queueEndMs = Math.max(this.#queueEndMs, now)
    // const queueAheadMs = this.#queueEndMs - now

    // const isQueueTooLong = queueAheadMs > this.#MAX_QUEUE_MS && queueAheadMs > 0
    // if (isQueueTooLong) return //Needed?

    const endOfMidiReached = this.#currentNoteIdx >= this.#notes.length
    if (endOfMidiReached) {
      this.#currentNoteIdx = 0
      this.#advanceToNextSong()
      this.#webviewProvider?.postSongList()
      return
    }

    //lastNoteRealTime is the RealTime when the last note starts playing
    //lastNoteLogTime is the midi time when the block starts playing
    //this.#currentNoteIdx is the next node to be played.
    //Thus, the delay imposed on the current note is how much logical time needs to pass minus how much real time has passed.
    
    
    const currentNoteLogicTime = this.#notes[this.#currentNoteIdx].time
    const lastNoteIdx = findLastNote(this.#notes, this.#currentNoteIdx, currentNoteLogicTime + WINDOW_LENGTH_SECS)

    const windowNotes = this.#notes.slice(this.#currentNoteIdx, lastNoteIdx)
    //if no notes are captured, play the next one as compensation
    // if (!windowNotes.length) { windowNotes.push(this.#notes[this.#currentNoteIdx]); scanIdx++ } 

    const pcm = this.#renderGroup(windowNotes)

    const now = performance.now() * 1000
    const scheduledRealTime = this.#lastNoteRealTime + (currentNoteLogicTime - this.#lastNoteLogicTime)
    const currentNoteRealTime = Math.max(now, scheduledRealTime)
    const delay = currentNoteRealTime - now
    if (delay > this.#maxDelay) return
    const delayed_pcm = this.#prependSilence(pcm, delay)

    Speaker.sendNoteToSpeaker(delayed_pcm) 
    // this.#queueEndMs = this.#queueEndMs + WINDOW_LENGTH_SECS * 1000
    this.#currentNoteIdx = lastNoteIdx
    this.#lastNoteRealTime = currentNoteRealTime
    this.#lastNoteLogicTime = currentNoteLogicTime
    this.#webviewProvider?.postSongList()

    vscode.window.setStatusBarMessage(`🎵 ${windowNotes.map(n => n.name).join('+')}`, 1500)
    
    function findLastNote(notes, startIdx, endTime){
      let currentIdx = startIdx
      while(currentIdx < notes.length && notes[currentIdx].time <= endTime){
        currentIdx++
      }
      return currentIdx
    }
  }

  static #midiToNoteName(midi) {
    return `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`
  }
}

module.exports = MusicTyping
