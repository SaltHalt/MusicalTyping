const vscode = require('vscode')
const MusicTyping = require('./MusicTyping')
const SoundFont = require('./SoundFont')
const Speaker = require('./Speaker')
const WebviewProvider = require('./WebviewProvider')
const Logger = require('./Logger')
const path = require('path')

async function activate(context) {
  console.log("ACTIVATE")
  const log = vscode.window.createOutputChannel('Akaza\'s Love', { log: true })
  context.subscriptions.push(log)
  Logger.init(log)

  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)
  statusBarItem.text = 'Akaza: activating...'
  statusBarItem.color = '#ffbbff'
  statusBarItem.command = 'akazas-love.showPanel'
  statusBarItem.show()
  context.subscriptions.push(statusBarItem)

  // ── SoundFont ──────────────────────────────────────────────────────────────
  SoundFont.init(context.globalStoragePath, {
    onStatus:   msg => statusBarItem.text = msg,
    onProgress: pct => statusBarItem.text = `🎹 Decoding piano samples… ${pct}%`,
  }).catch(e => console.error('SoundFont init failed:', e))

  // ── Speaker ────────────────────────────────────────────────────────────────
  const binDir = path.join(context.extensionPath, 'bin')
  Speaker.setupSpeaker(binDir, {
    onStatus: msg  => vscode.window.setStatusBarMessage(msg, 3000),
    onError:  msg  => vscode.window.showErrorMessage(msg),
    onPlayingChanged: isPlaying =>
      vscode.commands.executeCommand('setContext', 'akazas-love.playing', isPlaying),
  }).then(() => {
    statusBarItem.text = 'Akaza: Ready ❄️'
  }).catch(() =>
    vscode.window.setStatusBarMessage('⚠️ play-buffer setup failed', 3000))

  // ── MusicTyping ────────────────────────────────────────────────────────────
  const webviewProvider = new WebviewProvider(context)

  const cfg1 = () => vscode.workspace.getConfiguration('akazas-love')

  await MusicTyping.init({
    mediaDir: vscode.workspace.getConfiguration('akazas-love').get('mediaDir'),
    cacheDir: context.globalStoragePath,
    binDir,
    // getConfig is called on every keypress and every song boundary —
    // always returns the freshest VSCode settings values
    getConfig: () => {
      const cfg = cfg1()
      return {
        musicTyping: cfg.get('musicTyping'),
        volume:      cfg.get('volume'),
        shuffle:     cfg.get('shuffle'),
        loop:        cfg.get('loop'),
        windowSize:  cfg.get('windowSize'),
        maxDelay:    cfg.get('maxDelay'),
      }
    },
    onSongChange: () => webviewProvider.postSongList(),
  })

  // ── Commands & providers ───────────────────────────────────────────────────
  const rc = vscode.commands.registerCommand
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('akazas-love.webview', webviewProvider),
    rc('akazas-love.playSong',     () => MusicTyping.playMidiFile(true)),
    rc('akazas-love.stopSong',     () => MusicTyping.playMidiFile(false)),
    rc('akazas-love.showPanel',    () => vscode.commands.executeCommand('akazas-love.webview.focus')),
    rc('akazas-love.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', '@ext:lanly-dev.akazas-love')),
    rc('akazas-love.toggleMusicTyping', () => {
      const cfg = vscode.workspace.getConfiguration('akazas-love')
      cfg.update('musicTyping', !cfg.get('musicTyping'))
    }),
  )
}

function deactivate() {
  Speaker.stopAllProcesses()
}

module.exports = { activate, deactivate }
