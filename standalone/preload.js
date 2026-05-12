const { contextBridge, ipcRenderer } = require('electron')

// Exposes a minimal, typed API to the renderer (index.html).
// Replaces acquireVsCodeApi() from the VSCode webview.
contextBridge.exposeInMainWorld('api', {
  // Renderer → main (mirrors vscode.postMessage)
  postMessage: (msg) => ipcRenderer.send('FROM_RENDERER', msg),

  // Main → renderer (mirrors window.addEventListener('message', ...))
  onMessage: (cb) => {
    const handler = (_, msg) => cb(msg)
    ipcRenderer.on('TO_RENDERER', handler)
    // Return cleanup function so callers can unsubscribe if needed
    return () => ipcRenderer.removeListener('TO_RENDERER', handler)
  },
})
