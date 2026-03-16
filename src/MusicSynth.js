const fs = require('fs')
const pkg = require('@tonejs/midi')
const { Midi } = pkg
const SoundFont = require('./SoundFont')

const SAMPLE_RATE = 44100

class MusicSynth {

  // Generate PCM for a single note from a soundfont sample.
  // `startTime` is in seconds and is used to calculate the startSample offset
  // when mixing into a full-song buffer. Pass 0 for individual keystroke notes.
  static generateNote(midiNote, duration, startTime, options = {}) {
    const velocity = Math.min(1.0, options.velocity ?? 0.8)
    const chordScale = options.chordScale ?? 1.0

    const playDuration = Math.max(duration, 0.05)
    const startSample = Math.floor(SAMPLE_RATE * startTime)

    const floatBuffer = SoundFont.isReady
      ? SoundFont.getSample(midiNote, playDuration, velocity * chordScale)
      : new Float32Array(Math.ceil(playDuration * SAMPLE_RATE))  // silence fallback

    return { floatBuffer, samples: floatBuffer.length, startSample }
  }

  // Build a complete mixed PCM buffer for a whole MIDI file.
  static async getMidiFileBuffer(midiFilePath) {
    await SoundFont.waitUntilReady()

    const midi = new Midi(fs.readFileSync(midiFilePath))

    const allNotes = []
    midi.tracks.forEach(track => {
      track.notes.forEach(note => {
        allNotes.push({
          midi: note.midi,
          startTime: note.time,
          duration: note.duration,
          velocity: note.velocity,
        })
      })
    })
    allNotes.sort((a, b) => a.startTime - b.startTime)

    // Group simultaneous notes so we can scale their volume proportionally,
    // preventing dense chords from clipping.
    const timeFrames = new Map()
    allNotes.forEach(note => {
      const key = Math.round(note.startTime * 1000)
      if (!timeFrames.has(key)) timeFrames.set(key, 0)
      timeFrames.set(key, timeFrames.get(key) + 1)
    })
    allNotes.forEach(note => {
      note.chordScale = 1 / timeFrames.get(Math.round(note.startTime * 1000))
    })

    const totalDuration = Math.max(
      midi.duration,
      ...allNotes.map(n => n.startTime + n.duration)
    ) + 0.5  // let last notes ring out
    const totalSamples = Math.ceil(SAMPLE_RATE * totalDuration)
    const mix = new Float32Array(totalSamples)

    for (const note of allNotes) {
      const { floatBuffer, startSample } = this.generateNote(
        note.midi,
        note.duration,
        note.startTime,
        { velocity: note.velocity, chordScale: note.chordScale }
      )
      for (let i = 0; i < floatBuffer.length && startSample + i < totalSamples; i++) {
        mix[startSample + i] += floatBuffer[i]
      }
    }

    // Soft clip the final mix — tanh keeps peaks musical rather than harsh
    for (let i = 0; i < totalSamples; i++) {
      mix[i] = Math.tanh(mix[i])
    }

    return Buffer.from(mix.buffer)
  }
}

module.exports = MusicSynth
