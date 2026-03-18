const vscode = require('vscode')
const path = require('path')

class WebviewProvider {
  #context
  #webview
  // Minimal inline typing-rate tracker (was TypingRate.js)
  #keystrokeTs = []

  constructor(context) { this.#context = context }

  resolveWebviewView(webviewView) {
    webviewView.webview.options = { enableScripts: true }
    webviewView.webview.html = this.#getHtml()
    this.#webview = webviewView.webview

    webviewView.webview.onDidReceiveMessage(msg => {
      if (!msg?.type) return
      const MT = require('./MusicTyping')
      switch (msg.type) {
        case 'SELECT_SONG': MT.selectSong(msg.idx); break
        case 'TOGGLE_SHUFFLE': MT.setShuffle(msg.value); break
        case 'TOGGLE_LOOP': MT.setLoop(msg.value); break
        case 'PLAY': vscode.commands.executeCommand('akazas-love.playSong'); break
        case 'STOP': vscode.commands.executeCommand('akazas-love.stopSong'); break
      }
    })

    this.#context.subscriptions.push(
      webviewView.onDidChangeVisibility(() => {
        if (webviewView.visible) { this.#postMessage(this.#getConfig()); this.postSongList() }
      })
    )
    this.#postMessage(this.#getConfig())
    this.postSongList()
  }

  keyPress() {
    const now = Date.now()
    this.#keystrokeTs.push(now)
    while (this.#keystrokeTs.length && now - this.#keystrokeTs[0] > 2000) this.#keystrokeTs.shift()
    const rate = this.#keystrokeTs.length < 2 ? 0 : this.#keystrokeTs.length / 2
    this.#postMessage({ type: 'KEY', typingRate: rate })
  }

  reloadConfigs() { this.#postMessage(this.#getConfig()) }

  postSongList() {
    const MT = require('./MusicTyping')
    this.#postMessage({ type: 'SONG_LIST', ...MT.getSongList() })
  }

  #getConfig() {
    const cfg1 = vscode.workspace.getConfiguration('akazas-love')
    const cfg2 = vscode.workspace.getConfiguration('akazas-love.snowPanelConfigs')
    const isLight = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Light
    const hex = cfg2.get(isLight ? 'colorLight' : 'colorDark')
      || cfg2.inspect(isLight ? 'colorLight' : 'colorDark').defaultValue
    return {
      type: 'CONFIG',
      typingDriven: cfg1.get('typingDriven'),
      density: cfg2.get('density'),
      color: this.#hexToRgba(hex),
      backgroundColor: cfg2.get('backgroundColor'),
    }
  }

  #getHtml() {
    const fs = require('fs')
    return fs.readFileSync(path.join(this.#context.extensionPath, 'dist', 'index.html'), 'utf8')
  }

  #hexToRgba(hex) {
    if (!hex) return ''
    const c = hex.replace('#', '').replace(/^(.)(.)(.)$/, '$1$1$2$2$3$3')
    const [r, g, b] = [0, 2, 4].map(i => parseInt(c.slice(i, i + 2), 16))
    return `rgba(${r},${g},${b},`
  }

  #postMessage(msg) { this.#webview?.postMessage(msg) }
}

module.exports = WebviewProvider
