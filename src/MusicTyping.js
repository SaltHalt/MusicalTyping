const { Midi } = require('@tonejs/midi')
const fs = require('fs')
const path = require('path')
const vscode = require('vscode')

const Speaker = require('./Speaker')
const MusicSynth = require('./MusicSynth')

class MusicalTyping {

  static #context
  static #webviewProvider

  static #enabled
  static #volume

  static #currentNoteIdx
  static #notes

  static #songList       // [{ name: string, path: string }]
  static #currentSongIdx
  static #shuffle
  static #loop
  static #isPlaying

  static #playStartTime   // Date.now() when playback began
  static #totalDuration   // seconds, from MusicSynth

  static #MAX_QUEUE_MS = 1000  // max lookahead in ms — keypresses beyond this are ignored
  static #midiDuration = 0    // total duration of current MIDI file in seconds
  static #queueEndMs = 0      // absolute Date.now() timestamp when queued audio ends

  static init(context, webviewProvider) {
    this.#context = context
    this.#webviewProvider = webviewProvider

    this.#notes = []
    this.#currentNoteIdx = 0
    this.#currentSongIdx = 0
    this.#isPlaying = false
    this.#playStartTime = null
    this.#totalDuration = null

    try {
      this.#loadConfiguration()
      this.#scanSongList()
      this.#loadCurrentMidi()
      this.#setupEventListeners()
    } catch (error) {
      console.error('Error initializing MusicalTyping:', error)
    }

    this.stopBtn = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
    this.stopBtn.command = 'akazas-love.stopSong'
    this.stopBtn.text = '⏹️ Stop'
    this.#context.subscriptions.push(this.stopBtn)
  }

  // Scan media/ for all .mid files and build the song list
  static #scanSongList() {
    const mediaDir = path.join(this.#context.extensionPath, 'media')
    let files = []
    try {
      files = fs.readdirSync(mediaDir).filter(f => f.toLowerCase().endsWith('.mid'))
    } catch (e) {
      console.error('Failed to scan media/ for MIDI files:', e)
    }

    this.#songList = files.map(f => ({
      name: path.basename(f, path.extname(f)),
      path: path.join(mediaDir, f)
    }))

    if (this.#songList.length === 0) {
      console.error('No .mid files found in media/')
    } else {
      console.log(`Found ${this.#songList.length} MIDI file(s): ${this.#songList.map(s => s.name).join(', ')}`)
    }
  }

  static #loadCurrentMidi() {
    if (this.#songList.length === 0) return
    this.#loadMidiFile(this.#songList[this.#currentSongIdx].path)
  }

  static getSongList() {
    const elapsed = (this.#isPlaying && this.#playStartTime)
      ? (Date.now() - this.#playStartTime) / 1000
      : null
    const midiProgress = this.#notes.length > 0
      ? this.#currentNoteIdx / this.#notes.length
      : 0
    return {
      songs: this.#songList.map(s => s.name),
      currentIdx: this.#currentSongIdx,
      shuffle: this.#shuffle,
      loop: this.#loop,
      isPlaying: this.#isPlaying,
      elapsed,
      totalDuration: this.#totalDuration,
      midiProgress,         // 0..1 fraction through the MIDI note sequence
      midiDuration: this.#midiDuration
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

  static setLoop(value) {
    this.#loop = value
    this.#webviewProvider?.postSongList()
  }

  static setShuffle(value) {
    this.#shuffle = value
    this.#webviewProvider?.postSongList()
  }

  // Called by Speaker when a full-song play finishes naturally
  static onSongFinished() {
    this.#isPlaying = false
    this.#playStartTime = null
    this.#totalDuration = null
    this.stopBtn.hide()
    vscode.commands.executeCommand('setContext', 'akazas-love.playing', false)

    if (!this.#loop && !this.#shuffle) {
      this.#webviewProvider?.postSongList()
      return
    }

    this.#advanceToNextSong()
    this.playMidiFile(true)
  }

  static #advanceToNextSong() {
    if (this.#songList.length <= 1) return
    if (this.#shuffle) {
      let next
      do { next = Math.floor(Math.random() * this.#songList.length) }
      while (next === this.#currentSongIdx && this.#songList.length > 1)
      this.#currentSongIdx = next
    } else {
      this.#currentSongIdx = (this.#currentSongIdx + 1) % this.#songList.length
    }
    this.#currentNoteIdx = 0
    this.#loadCurrentMidi()
  }

  static async playMidiFile(needPlay) {
    if (needPlay) {
      if (this.#songList.length === 0) {
        vscode.window.showWarningMessage('No MIDI files found in media/')
        return
      }
      const midiPath = this.#songList[this.#currentSongIdx].path
      const buffer = await MusicSynth.getMidiFileBuffer(midiPath)
      // MusicSynth.getMidiFileBuffer works at 44100Hz, Float32 mono — derive duration from buffer size
      this.#totalDuration = (buffer.length / 4) / 44100  // 4 bytes per Float32 sample
      this.#playStartTime = Date.now()
      this.#isPlaying = true
      this.#webviewProvider?.postSongList()
      Speaker.sendToSpeaker(buffer, () => MusicalTyping.onSongFinished())
      this.stopBtn.show()
    } else {
      this.#isPlaying = false
      this.#playStartTime = null
      this.#totalDuration = null
      Speaker.stopToSpeaker()
      this.stopBtn.hide()
      this.#webviewProvider?.postSongList()
    }
  }

  static #loadConfiguration() {
    const config = vscode.workspace.getConfiguration('akazas-love')
    this.#enabled = config.get('musicTyping')
    this.#volume = config.get('volume')
    this.#shuffle = config.get('shuffle') ?? false
    this.#loop = config.get('loop') ?? true
  }

  static #setupEventListeners() {
    const changeDisposable = vscode.workspace.onDidChangeTextDocument((event) => {
      if (!this.#enabled || !event.contentChanges.length) return
      const change = event.contentChanges[0]
      if (change.text.length === 1 && (change.text === '\n' || change.text === '\r\n')) return
      try {
        this.#playMidiNotes(change.text)
      } catch (error) {
        console.error('Error playing MIDI notes:', error)
      }
    })

    const configDisposable = vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('akazas-love.musicTyping')) return
      this.#loadConfiguration()
      const message = this.#enabled ? '\U0001f3b6 Musical typing enabled' : '\u26d4 Musical typing disabled'
      vscode.window.setStatusBarMessage(message, 3000)
    })
    this.#context.subscriptions.push(changeDisposable, configDisposable)
  }

  // Play a single note after delayMs, using a fresh play-buffer process.
  static #scheduleNote(midiNote, duration, delayMs, options) {
    const SoundFont = require('./SoundFont')
    if (!SoundFont.isReady) return
    const noteResult = MusicSynth.generateNote(midiNote, duration, 0, options)
    const pcmBuffer = Buffer.from(noteResult.floatBuffer.buffer)
    const fire = () => {
      Speaker.sendNoteToSpeaker(pcmBuffer)
      const noteName = MusicalTyping.#frequencyToNoteName(440 * Math.pow(2, (midiNote - 69) / 12))
      vscode.window.setStatusBarMessage(`♪ ${noteName}`, 800)
    }
    if (delayMs <= 0) fire()
    else setTimeout(fire, delayMs)
  }

  static #playMidiNotes() {
    if (this.#notes.length === 0) return

    const now = Date.now()
    const queueAheadMs = Math.max(0, this.#queueEndMs - now)

    // --- Rule 2 + 3: block if queue is full, unless buffer is empty ---
    if (queueAheadMs > this.#MAX_QUEUE_MS && queueAheadMs > 0) {
      console.log(`[blocked] queueAheadMs=${queueAheadMs.toFixed(1)} noteIdx=${this.#currentNoteIdx}/${this.#notes.length}`)
      return
    }

    // --- End of MIDI: advance to next song ---
    if (this.#currentNoteIdx >= this.#notes.length) {
      this.#currentNoteIdx = 0
      this.#advanceToNextSong()
      this.#webviewProvider?.postSongList()
      return
    }

    // --- Rule 1: collect all notes starting within the next 40ms window ---
    const windowStart = this.#notes[this.#currentNoteIdx][0].time
    const windowEnd = windowStart + 0.040

    let windowGroups = []
    let scanIdx = this.#currentNoteIdx
    while (scanIdx < this.#notes.length &&
           this.#notes[scanIdx][0].time < windowEnd) {
      windowGroups.push(this.#notes[scanIdx])
      scanIdx++
    }
    if (windowGroups.length === 0) {
      windowGroups = [this.#notes[this.#currentNoteIdx]]
      scanIdx = this.#currentNoteIdx + 1
    }

    // Schedule each group with a delay = current queue depth + intra-window offset.
    for (const group of windowGroups) {
      const groupOffsetMs = (group[0].time - windowStart) * 1000
      const delayMs = queueAheadMs + groupOffsetMs

      group.forEach(note => {
        const playDuration = Math.max(note.duration, 0.3)
        this.#scheduleNote(note.midi, playDuration, delayMs, {
          velocity: note.velocity * this.#volume,
          chordScale: note.chordScale
        })
      })
    }

    // Advance #queueEndMs past the last group in this window
    const lastGroup = windowGroups[windowGroups.length - 1]
    const lastOffsetMs = (lastGroup[0].time - windowStart) * 1000
    const lastDurationMs = Math.max(...lastGroup.map(n => Math.max(n.duration, 0.3))) * 1000
    this.#queueEndMs = Math.max(now, this.#queueEndMs) + lastOffsetMs + lastDurationMs

    this.#currentNoteIdx = scanIdx
    this.#webviewProvider?.postSongList()

    // Log released notes for comparison against MIDI file
    const released = windowGroups.flatMap(g => g.map(n =>
      `${n.name}(${n.midi})@${n.time.toFixed(3)}s+${(n.time + n.duration).toFixed(3)}s`
    ))
    console.log(`[release] idx=${this.#currentNoteIdx} queueMs=${queueAheadMs.toFixed(1)} notes=${released.join(' ')}`)

    const noteNames = windowGroups.flatMap(g => g.map(n => n.name)).join('+')
    vscode.window.setStatusBarMessage(`🎵 ${noteNames}`, 1500)
  }

  static #loadMidiFile(midiPath) {
    const midiData = fs.readFileSync(midiPath)
    const midi = new Midi(midiData)

    // Collect notes from ALL tracks first, then group
    const allNotes = []
    midi.tracks.forEach(track => {
      track.notes.forEach(note => {
        allNotes.push({
          midi: note.midi,
          name: note.name,
          duration: note.duration,
          time: note.time,
          frequency: 440 * Math.pow(2, (note.midi - 69) / 12),
          velocity: note.velocity * 1.5
        })
      })
    })

    // Group by exact start time (simultaneous notes across any track form one group)
    const timeMap = {}
    allNotes.forEach(note => {
      if (!timeMap[note.time]) timeMap[note.time] = []
      timeMap[note.time].push(note)
    })

    const timeFrames = Object.keys(timeMap).map(Number).sort((a, b) => a - b)
    this.#notes = timeFrames.map(t => {
      const chordNotes = timeMap[t]
      return chordNotes.map(note => ({
        ...note,
        chordScale: 1 / chordNotes.length
      }))
    })

    // Store total MIDI duration for progress tracking
    const allTimes = allNotes.map(n => n.time + n.duration)
    this.#midiDuration = allTimes.length > 0 ? Math.max(...allTimes) : 0

    console.log(`Loaded MIDI: ${midi.tracks.length} tracks, ${allNotes.length} notes, ${this.#notes.length} time groups, ${this.#midiDuration.toFixed(1)}s`)
  }

  static #frequencyToNoteName(frequency) {
    const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
    const midiNote = Math.round(69 + 12 * Math.log2(frequency / 440))
    const octave = Math.floor(midiNote / 12) - 1
    const noteIndex = midiNote % 12
    return `${noteNames[noteIndex]}${octave}`
  }
}

module.exports = MusicalTyping
