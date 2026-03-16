const vscode = require('vscode')
const path = require('path')
const TypingRate = require('./TypingRate')

class WebviewProvider {

  #context
  #typingRate
  #webview

  /** @param {vscode.ExtensionContext} context */
  constructor(context) {
    this.#context = context
    this.#typingRate = new TypingRate()
  }

  /** @param {vscode.WebviewView} webviewView */
  resolveWebviewView(webviewView) {
    webviewView.webview.options = { enableScripts: true }
    const imgPath = webviewView.webview.asWebviewUri(
      vscode.Uri.file(path.join(this.#context.extensionPath, 'media', 'happy.png'))
    )
    webviewView.webview.html = this.#getHtmlFromFile(imgPath)

    // Listen for config changes and typing events from extension
    this.#webview = webviewView.webview

    // Handle messages from the webview UI
    webviewView.webview.onDidReceiveMessage(msg => {
      if (!msg?.type) return
      // Lazy require to avoid circular dependency at module load time
      const MusicTyping = require('./MusicTyping')
      switch (msg.type) {
        case 'SELECT_SONG':
          MusicTyping.selectSong(msg.idx)
          break
        case 'TOGGLE_SHUFFLE':
          MusicTyping.setShuffle(msg.value)
          break
        case 'TOGGLE_LOOP':
          MusicTyping.setLoop(msg.value)
          break
        case 'PLAY':
          vscode.commands.executeCommand('akazas-love.playSong')
          break
        case 'STOP':
          vscode.commands.executeCommand('akazas-love.stopSong')
          break
      }
    })

    const d = webviewView.onDidChangeVisibility(() => {
      // Inject initial params again, since it got reset when hidden
      if (webviewView.visible) {
        this.#postMessage(this.#getConfigs())
        this.postSongList()
      }
    })

    this.#postMessage(this.#getConfigs())
    this.postSongList()
    this.#context.subscriptions.push(d)
  }

  keyPress() {
    this.#typingRate.recordKeystroke()
    const typingRate = this.#typingRate.getRate()
    this.#postMessage({ type: 'KEY', typingRate })
  }

  reloadConfigs() {
    this.#postMessage({ type: 'CONFIG', ...this.#getConfigs() })
  }

  // Push current song list + state to the webview
  postSongList() {
    const MusicTyping = require('./MusicTyping')
    this.#postMessage({ type: 'SONG_LIST', ...MusicTyping.getSongList() })
  }

  #getConfigs() {
    const cfg1 = vscode.workspace.getConfiguration('akazas-love')
    const cfg2 = vscode.workspace.getConfiguration('akazas-love.snowPanelConfigs')

    const colorLight = cfg2.get('colorLight')
    const colorDark = cfg2.get('colorDark')
    const themeKind = vscode.window.activeColorTheme.kind

    let color
    if (colorLight) {
      if (themeKind === vscode.ColorThemeKind.Light) color = colorLight
      else color = colorDark
    } else {
      if (themeKind === vscode.ColorThemeKind.Light) color = cfg2.inspect('colorLight').defaultValue
      else color = cfg2.inspect('colorDark').defaultValue
    }
    return {
      type: 'CONFIG',
      typingDriven: cfg1.get('typingDriven'),
      density: cfg2.get('density'),
      color: this.#hexToRgba(color),
      backgroundColor: cfg2.get('backgroundColor')
    }
  }

  #getHtmlFromFile(imgSrc) {
    const fs = require('fs')
    // To get the absolute path to ./src/index.html
    const htmlPath = path.join(this.#context.extensionPath, 'dist', 'index.html')

    let html = fs.readFileSync(htmlPath, 'utf8')
    html = html.replace('{{IMG_SRC}}', imgSrc)
    return html
  }

  // Convert hex color to rgba string
  #hexToRgba(hex) {
    if (!hex) return
    let c = hex.replace('#', '')
    if (c.length === 3) c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2]
    if (c.length !== 6) console.error(`invalid hex color: ${hex}, proceeding with 6 characters`)
    const r = parseInt(c.substring(0, 2), 16)
    const g = parseInt(c.substring(2, 4), 16)
    const b = parseInt(c.substring(4, 6), 16)
    return `rgba(${r},${g},${b},`
  }

  /**
   * Send a message to the webview (from extension)
   * @param {object} msg
   */
  #postMessage(msg) {
    this.#webview?.postMessage(msg)
  }
}

module.exports = WebviewProvider
