const vscode = require('vscode')
const MusicTyping = require('./MusicTyping')
const SoundFont = require('./SoundFont')
const Speaker = require('./Speaker')
const WebviewProvider = require('./WebviewProvider')

async function activate(context) {
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)
  statusBarItem.text = 'Akaza: activating...'
  statusBarItem.color = '#ffbbff'
  statusBarItem.command = 'akazas-love.showPanel'
  statusBarItem.show()

  SoundFont.init(context).catch(e => console.error('SoundFont init failed:', e))
  Speaker.setupSpeaker(context, statusBarItem).catch(() =>
    vscode.window.setStatusBarMessage('⚠️ play-buffer setup failed', 3000))

  const webviewProvider = new WebviewProvider(context)
  MusicTyping.init(context, webviewProvider)

  const rc = vscode.commands.registerCommand
  context.subscriptions.push(
    statusBarItem,
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
