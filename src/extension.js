const vscode = require('vscode')

const MusicTyping = require('./MusicTyping')
const SnowEngine = require('./SnowEngine')
const SoundFont = require('./SoundFont')
const Speaker = require('./Speaker')
const WebviewProvider = require('./WebviewProvider')

/**
 * @param {vscode.ExtensionContext} context
 */
async function activate(context) {

  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)
  statusBarItem.text = 'Akaza: activating...'
  statusBarItem.color = '#ffbbff'
  statusBarItem.command = 'akazas-love.showPanel'
  statusBarItem.show()

  // Kick off soundfont sample download/load in background
  SoundFont.init(context).catch(e => console.error('SoundFont init failed:', e))

  Speaker.setupSpeaker(context, statusBarItem).then(() => vscode.window.setStatusBarMessage('🔊 play-buffer ready', 3000)
  ).catch(() => vscode.window.setStatusBarMessage('⚠️ play-buffer setup failed', 3000))

  const webviewProvider = new WebviewProvider(context)
  try {
    // Pass webviewProvider into MusicTyping so it can push song-list updates
    MusicTyping.init(context, webviewProvider)
    SnowEngine.init(context, webviewProvider)
  } catch (error) {
    console.error('Error initializing extensions:', error)
  }
  const d0 = vscode.window.registerWebviewViewProvider('akazas-love.webview', webviewProvider)

  const rc = vscode.commands.registerCommand
  const d1a = rc('akazas-love.playSong', () => MusicTyping.playMidiFile(true))
  const d1b = rc('akazas-love.stopSong', () => MusicTyping.playMidiFile(false))

  const d2 = rc('akazas-love.toggleMusicTyping', toggleMusicTyping)
  const d2a = rc('akazas-love.toggleMusicTypingOn', toggleMusicTyping)
  const d2b = rc('akazas-love.toggleMusicTypingOff', toggleMusicTyping)

  const d3 = rc('akazas-love.toggleSnowInEditor', toggleShowInEditor)
  const d3a = rc('akazas-love.toggleSnowInEditorOn', toggleShowInEditor)
  const d3b = rc('akazas-love.toggleSnowInEditorOff', toggleShowInEditor)

  const d4 = rc('akazas-love.toggleSnowDriven', toggleTypingDriven)
  const d4a = rc('akazas-love.toggleSnowDrivenOn', toggleTypingDriven)
  const d4b = rc('akazas-love.toggleSnowDrivenOff', toggleTypingDriven)

  const d5 = rc('akazas-love.showPanel', () => {
    vscode.commands.executeCommand('akazas-love.webview.focus')
  })

  const d6 = rc('akazas-love.openSettings', () => {
    vscode.commands.executeCommand('workbench.action.openSettings', '@ext:lanly-dev.akazas-love')
  })

  context.subscriptions.push(statusBarItem, d0, d1a, d1b, d2, d2a, d2b, d3, d3a, d3b, d4, d4a, d4b, d5, d6)
}

function toggleMusicTyping() {
  const mt = vscode.workspace.getConfiguration('akazas-love').get('musicTyping')
  vscode.workspace.getConfiguration('akazas-love').update('musicTyping', !mt)
}

function toggleTypingDriven() {
  const td = vscode.workspace.getConfiguration('akazas-love').get('typingDriven')
  vscode.workspace.getConfiguration('akazas-love').update('typingDriven', !td)
}

function toggleShowInEditor() {
  const sie = vscode.workspace.getConfiguration('akazas-love').get('snowInEditor')
  vscode.workspace.getConfiguration('akazas-love').update('snowInEditor', !sie)
}

// This method is called when your extension is deactivated
function deactivate() {
  try {
    Speaker.stopAllProcesses()
  } catch (e) {
    vscode.window.showErrorMessage('Error stopping Speaker processes: ' + e.message)
  }
}

module.exports = { activate, deactivate }
