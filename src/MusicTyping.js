const { Midi } = require('@tonejs/midi')
const { xzSync, unxzSync } = require('node-liblzma')
const fs = require('fs')
const path = require('path')
const vscode = require('vscode')
const v8 = require('v8')
const Speaker = require('./Speaker')
const SoundFont = require('./SoundFont')
const Logger = require('./Logger')

const SAMPLE_RATE = 44100
// const WINDOW_LENGTH_SECS = 0.2
// const MAX_DELAY = 1
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

class MusicTyping {
  static #keyCounter = 0

  static #context
  static #webviewProvider
  static #enabled
  static #volume
  static #progressInterval = null

  static #cacheDir = null
  // static #notes = []           // flat array of notes sorted by start time
  static #pcms = []                    // flat array of notes sorted by start time
  static #currentNoteIdx = 0
  static #lastNoteRealTime = performance.now() / 1000
  static #lastNoteLogicTime = 0

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
    Logger.info("1")
    this.#context = context
    this.#webviewProvider = webviewProvider

    Logger.info("2")
    const config = vscode.workspace.getConfiguration('akazas-love')
    Logger.info("3")
    this.#enabled = config.get('musicTyping')
    this.#volume = config.get('volume')
    this.#shuffle = config.get('shuffle') ?? false
    this.#loop = config.get('loop') ?? true
    Logger.info("4")
    Logger.info("5")
    Logger.info("6")
    this.#cacheDir = path.join(context.globalStoragePath, 'midi_cache')
    Logger.info("7")
    Logger.info(this.#cacheDir)
    fs.mkdirSync(this.#cacheDir, { recursive: true })

    this.#scanSongList()

      ; (async () => {
        await SoundFont.waitUntilReady()
        this.#loadCurrentMidi()
      })().catch(e => Logger.error('MusicTyping async init failed:', e))
    Logger.info("A")
    this.stopBtn = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
    Logger.info("B")
    this.stopBtn.command = 'akazas-love.stopSong'
    this.stopBtn.text = 'Stop'
    Logger.info("C")
    context.subscriptions.push(this.stopBtn)
    Logger.info("D")

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
    const mediaDir = vscode.workspace.getConfiguration('akazas-love').get('mediaDir')
    try {
      this.#songList = fs.readdirSync(mediaDir)
        .filter(f => f.toLowerCase().endsWith('.mid'))
        .map(f => ({ name: path.basename(f, '.mid'), path: path.join(mediaDir, f) }))
    } catch (e) {
      Logger.error('Failed to scan media/ for MIDI files:', e)
    }
    Logger.info(`Found ${this.#songList.length} MIDI file(s)`)
  }

  static #loadCurrentMidi() {
    if (this.#songList.length === 0) return
    //if cache not found
    const midiPath = this.#songList[this.#currentSongIdx].path

    const baseName = /.*\\([^\\]*)\..*/.exec(midiPath)[1]

    const cacheFile = path.join(this.#cacheDir, baseName + ".pcms")

    if (fs.existsSync(cacheFile)) {
      const compressed = fs.readFileSync(cacheFile)
      const buf = unxzSync(compressed)
      const { duration, pcms } = v8.deserialize(buf)
      this.#midiDuration = duration
      this.#pcms = pcms
      Logger.info(`Loaded cache: ${this.#midiDuration.toFixed(1)}s, ${buf.length / 1000000} MB`)
    } else {
      const midi = this.#readMidiFile(midiPath)
      const notes = this.#extractNotes(midi)
      this.#pcms = this.#preRenderNotes(notes)
      const pcmSize = this.#pcms.reduce(((acc, pcm) => acc + pcm.pcm.byteLength), 0)
      this.#midiDuration = midi.duration

      const buf = v8.serialize({ duration: this.#midiDuration, pcms: this.#pcms })
      const compressed = xzSync(buf, { preset: 9 })

      fs.writeFileSync(cacheFile, compressed)

      Logger.info(`Loaded: ${midi.tracks.length} tracks, ${notes.length} notes, ${this.#midiDuration.toFixed(1)}s, ${pcmSize / 1000000} MB`)
    }
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
      clearInterval(this.#progressInterval)
      this.#progressInterval = null
      this.#webviewProvider?.postSongList()
      return
    }
    if (!this.#songList.length) { vscode.window.showWarningMessage('No MIDI files found in media/'); return }
    await SoundFont.waitUntilReady()
    // const buffer = await this.#renderMidiToBuffer(this.#songList[this.#currentSongIdx].path)
    const buffer = this.#mixNotes(this.#pcms).map(x => x * this.#volume).map(Math.tanh)
    this.#totalDuration = buffer.length / SAMPLE_RATE
    this.#playStartTime = Date.now()
    this.#isPlaying = true
    this.#webviewProvider?.postSongList()

    clearInterval(this.#progressInterval)
    this.#progressInterval = setInterval(() => this.#webviewProvider?.postSongList(), 1000)

    Speaker.sendToSpeaker(buffer, () => {
      this.#isPlaying = false
      this.#playStartTime = null
      this.#totalDuration = null
      this.stopBtn.hide()
      clearInterval(this.#progressInterval)
      this.#progressInterval = null
      // vscode.commands.executeCommand('setContext', 'akazas-love.playing', false)
      // Logger.info("Callback activates.")
      if (this.#loop || this.#shuffle) { this.#advanceToNextSong(); this.playMidiFile(true) }
      else this.#webviewProvider?.postSongList()
    })
    this.stopBtn.show()
  }

  //Flattens and sorts notes by start time.
  static #readMidiFile(midiPath) {
    return new Midi(fs.readFileSync(midiPath))
  }

  static #extractNotes(midi) {
    const midiTracks = midi.tracks.filter(track => track.notes.length > 0)
    // await loadInstruments(midiTracks.map(track => track.instrument.number))
    let allNotes = []
    for (const track_i in midiTracks) {
      const track = midiTracks[track_i]
      const instrument = track.instrument.number
      for (const note_i in track.notes) {
        const note = track.notes[note_i]
        note.instrument = instrument
        allNotes.push(note)
      }
    }
    allNotes.sort((a, b) => a.time - b.time)
    //TODO: Do i need to worry about midi.header? 
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
  static #renderNote(note) {
    return SoundFont.getSample(note.midi, Math.max(note.duration, 0.05), Math.min(1.0, note.velocity))//, note.instrument)) //Should I add this.#volume here?
  }

  // We do rendering first, mixing second
  // notes must be in order
  // #render consumes a map and spits out a pcm... tanh'd.
  static #renderGroup(notes) {
    const group_start_sample = Math.floor(notes[0].time * SAMPLE_RATE)
    const group_duration = Math.max(...notes.map(n => n.time + n.duration))
    const totalSamples = Math.floor(SAMPLE_RATE * group_duration) - group_start_sample + 1
    const mix = new Float32Array(totalSamples)

    for (const note of notes) {
      const pcm = this.#renderNote(note) //TODO: Doesn't consider instrument.
      const start = Math.floor((note.time) * SAMPLE_RATE) - group_start_sample
      for (let i = 0; i < pcm.length && start + i < totalSamples; i++) {
        mix[start + i] += pcm[i]
      }
    }
    return mix
  }

  static #mixNotes(pcms) {
    const precedingSamples = Math.floor(pcms[0].time * SAMPLE_RATE)
    let sampleCount = Math.max(...pcms.map(pcm => Math.floor(pcm.time * SAMPLE_RATE) + pcm.pcm.length)) - precedingSamples
    let out_pcm = new Float32Array(sampleCount)
    for (const pcm_i in pcms) {
      const offset = Math.floor(pcms[pcm_i].time * SAMPLE_RATE) - precedingSamples
      const pcm = pcms[pcm_i].pcm
      for (let i = 0; i < pcm.length; i++) {
        // if (i in out_pcm){
        out_pcm[offset + i] += pcm[i]
        // } else{
        // out_pcm[offset + i] = pcm[i]
        // }
      }
    }
    return out_pcm
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
    //Await load instruments
    const midi = this.#readMidiFile(midiPath)
    const allNotes = this.#extractNotes(midi)
    return this.#renderGroup(allNotes).map(Math.tanh)
  }

  static #preRenderNotes(notes) {
    const renderedNotes = []
    for (let i = 0; i < notes.length; i++) {
      let group = {}
      group.time = notes[i].time
      const start_i = i
      while (i + 1 < notes.length && notes[i + 1].time <= group.time) {
        i++
      }
      group.pcm = this.#renderGroup(notes.slice(start_i, i + 1))
      renderedNotes.push(group)
    }
    return renderedNotes
  }
  // ── Typing playback ────────────────────────────────────────────────────────

  static #playMidiNotes() {
    if (!this.#pcms?.length) return //If pcms isn't ready, ignore keypress.

    // Logger.info(this.#keyCounter)
    this.#keyCounter++
    const endOfMidiReached = this.#currentNoteIdx >= this.#pcms.length
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
    const windowLength = vscode.workspace.getConfiguration('akazas-love').get('windowSize')
    const currentNoteLogicTime = this.#pcms[this.#currentNoteIdx].time
    const lastNoteIdx = findLastNote(this.#pcms, this.#currentNoteIdx, currentNoteLogicTime + windowLength)

    const windowNotes = this.#pcms.slice(this.#currentNoteIdx, lastNoteIdx)

    const pcm = this.#mixNotes(windowNotes).map(x => x * this.#volume).map(Math.tanh)

    const now = performance.now() / 1000
    const proposedScheduledRealTime = this.#lastNoteRealTime + (currentNoteLogicTime - this.#lastNoteLogicTime)
    const currentNoteRealTime = Math.max(now, proposedScheduledRealTime)
    const delay = currentNoteRealTime - now
    const max_delay = vscode.workspace.getConfiguration('akazas-love').get('maxDelay')
    if (delay > max_delay) {
      // Logger.info("SKIPPED!")  
      return
    }
    // Logger.info(delay)
    // Logger.info(`ScheduledTime: ${scheduledRealTime}, Now: ${now}, Delay: ${delay}`)
    // const delayed_pcm = this.#prependSilence(pcm, delay)
    // Logger.info(pcm.length)
    // const t = performance.now()
    if (delay > 0) {
      setTimeout(() => {
        Speaker.sendNoteToSpeaker(pcm)
        // Logger.info('error=', performance.now()/1000 - currentNoteRealTime , 'ms')
      }, delay * 1000)

    } else {
      Speaker.sendNoteToSpeaker(pcm)
    }
    // Speaker.sendNoteToSpeaker(delayed_pcm) 
    // Logger.info('send took', performance.now() - t, 'ms')
    this.#currentNoteIdx = lastNoteIdx
    this.#lastNoteRealTime = currentNoteRealTime
    this.#lastNoteLogicTime = currentNoteLogicTime
    this.#webviewProvider?.postSongList()

    // vscode.window.setStatusBarMessage(`🎵 ${windowNotes.map(n => n.name).join('+')}`, 1500)

    function findLastNote(notes, startIdx, endTime) {
      let currentIdx = startIdx
      while (currentIdx < notes.length && notes[currentIdx].time <= endTime) {
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
