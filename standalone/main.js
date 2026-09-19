const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage } = require('electron')
const path = require('path')
const fs = require('fs')
const MusicTyping = require('../src/MusicTyping')
const Speaker = require('../src/Speaker')
const SoundFont = require('../src/SoundFont')
const { getWindows, activeWindow } = require('get-windows')
const { uIOhook } = require('uiohook-napi')

// ── Config persistence ─────────────────────────────────────────────────────

const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json')

const DEFAULTS = {
  musicTyping: true,
  volume:      0.1,
  shuffle:     false,
  loop:        true,
  windowSize:  0.2,
  maxDelay:    3,
  mediaDir:    "D:\\Programs\\vscode-akazas-love\\media",
}

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8')
    return { ...DEFAULTS, ...JSON.parse(raw) }
  } catch {
    return { ...DEFAULTS }
  }
}

function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true })
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2))
}

// Live config object — getConfig() reads from this on every keypress
let config = loadConfig()

// ── App state ──────────────────────────────────────────────────────────────

let tray = null
let win  = null

async function isCurrentlyExempt(){
  let window = await activeWindow()
  sites = ["Krunker", "diep", "reddit", "4chan", "greentext", "desuarchive", "4plebs",
           "worldofsolitaire", "Shakashaka", "youtube"]
  return sites.some( w => window.title.includes(w))
}

// ── Window ─────────────────────────────────────────────────────────────────

function createWindow() {
  win = new BrowserWindow({
    width: 280,
    height: 420,
    resizable: false,
    frame: true,
    skipTaskbar: true,
    title: "Akaza's Love",
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  win.loadFile(path.join(__dirname, 'index.html'))
  win.setMenuBarVisibility(false)

  // Hide instead of close so tray click can re-show it
  win.on('close', e => {
    e.preventDefault()
    win.hide()
  })
}

// ── Tray ───────────────────────────────────────────────────────────────────

function createTray() {
  // Use a plain coloured icon if no icon file exists yet
  const iconPath = app.isPackaged
  ? path.join(process.resourcesPath, 'icons', 'tray.ico')
  : path.join(app.getAppPath(), 'icons', 'tray.ico')
  console.log(iconPath)
  const icon = fs.existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath)
    : nativeImage.createEmpty()

  tray = new Tray(icon)
  tray.setToolTip("Akaza's Love")
  tray.on('click', () => {
    if (win.isVisible()) { win.hide() } else { win.show(); win.focus() }
  })
  updateTrayMenu()
}

function updateTrayMenu() {
  const menu = Menu.buildFromTemplate([
    {
      label: config.musicTyping ? '🎵 Music Typing: ON' : '🔇 Music Typing: OFF',
      click: () => {
        config.musicTyping = !config.musicTyping
        saveConfig(config)
        updateTrayMenu()
        sendToRenderer({ type: 'CONFIG', ...config })
      }
    },
    { type: 'separator' },
    { label: 'Show Panel', click: () => { win.show(); win.focus() } },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.exit(0) } },
  ])
  tray.setContextMenu(menu)
}

// ── IPC — renderer → main ──────────────────────────────────────────────────

ipcMain.on('FROM_RENDERER', (_, msg) => {
  if (!msg?.type) return
  switch (msg.type) {
    case 'SELECT_SONG':
      MusicTyping.selectSong(msg.idx)
      break
    case 'TOGGLE_SHUFFLE':
      config.shuffle = msg.value
      saveConfig(config)
      MusicTyping.setShuffle(msg.value)
      break
    case 'TOGGLE_LOOP':
      config.loop = msg.value
      saveConfig(config)
      MusicTyping.setLoop(msg.value)
      break
    case 'PLAY':
      MusicTyping.playMidiFile(true)
      break
    case 'STOP':
      MusicTyping.playMidiFile(false)
      break
    case 'SET_CONFIG': {
      // Volume, windowSize, maxDelay, musicTyping sliders/toggles from the panel
      Object.assign(config, msg.patch)
      saveConfig(config)
      updateTrayMenu()
      // No need to push anything back — getConfig() will return the new values
      // on the next keypress automatically
      break
    }
    case 'GET_CONFIG':
      sendToRenderer({ type: 'CONFIG', ...config })
      break
  }
})

// ── Main → renderer ────────────────────────────────────────────────────────

function sendToRenderer(msg) {
  if (win && !win.isDestroyed()) win.webContents.send('TO_RENDERER', msg)
}

// ── App lifecycle ──────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  const cacheDir = app.getPath('userData')
  const binDir   = path.join(app.getPath('userData'), 'bin')

  // Status updates go to the tray tooltip and console
  const onStatus = (msg) => {
    console.log('[Status]', msg)
    tray?.setToolTip(msg)
    sendToRenderer({ type: 'STATUS', message: msg })
  }

  // ── SoundFont ────────────────────────────────────────────────────────────
  SoundFont.init(cacheDir, {
    onStatus,
    onProgress: pct => onStatus(`🎹 Decoding piano samples… ${pct}%`),
  }).catch(e => console.error('SoundFont init failed:', e))

  // ── Speaker ──────────────────────────────────────────────────────────────
  await Speaker.setupSpeaker(binDir, {
    onStatus,
    onError: msg => { console.error(msg); sendToRenderer({ type: 'ERROR', message: msg }) },
    onPlayingChanged: isPlaying => sendToRenderer({ type: 'PLAYING_CHANGED', isPlaying }),
  }).catch(e => console.error('Speaker setup failed:', e))

  // ── MusicTyping ──────────────────────────────────────────────────────────
  await MusicTyping.init({
    mediaDir: config.mediaDir,
    cacheDir,
    binDir,
    // Called on every keypress and every song boundary — reads live from config object
    getConfig: () => ({
      musicTyping: config.musicTyping,
      volume:      config.volume,
      shuffle:     config.shuffle,
      loop:        config.loop,
      windowSize:  config.windowSize,
      maxDelay:    config.maxDelay,
    }),
    onSongChange: () => sendToRenderer({ type: 'SONG_LIST', ...MusicTyping.getSongList() }),
  })

  // ── Global input ─────────────────────────────────────────────────────────
  uIOhook.on('keydown', key => {
    if (key.keycode in [29, 42, 56]) return;
    isCurrentlyExempt().then(result => {
      if (result) return;
      MusicTyping.onKeyPress()
    })
  })
  uIOhook.on('mousedown', () => {
    isCurrentlyExempt().then(result => {
      if (result) return;
      MusicTyping.onKeyPress();
    })
  })
  uIOhook.on('click', () => {
    isCurrentlyExempt().then(result => {
      if (result) return;
      MusicTyping.onKeyPress();
    })
  })
  uIOhook.start()

  // ── UI ───────────────────────────────────────────────────────────────────
  createWindow()
  createTray()

  onStatus("Akaza's Love ready ❄️")
})

app.on('window-all-closed', e => e.preventDefault())  // keep alive in tray

app.on('before-quit', () => {
  uIOhook.stop()
  Speaker.stopAllProcesses()
})

