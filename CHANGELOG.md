# Change Log
All notable changes to the "Akaza's Love" extension will be documented in this file. \
Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [TODO]
- Bug: there is issue from waking up after sleep - for binary
- Bug: not automatic switching speaker - for binary
- Stop status combination to extension status for playing
- Three modes for SnowInEditor - separate typingDriven from panel
- Add gif

## [1.0.2] - 2026-07-29
- Add notes
- Change default `snowInEditor` to `false` as default
- Update deps
 12 files, 7.06 MB, 1.30.0, req1.125.0
```
Done in 80ms
INFO  Files included in the VSIX:
akazas-love-1.0.2.vsix
├─ [Content_Types].xml
├─ extension.vsixmanifest
└─ extension/
   ├─ LICENSE.txt [1.06 KB]
   ├─ changelog.md [3.41 KB]
   ├─ package.json [10.63 KB]
   ├─ readme.md [2.48 KB]
   ├─ dist/
   │  ├─ extension.js [69.02 KB]
   │  └─ index.html [3.74 KB]
   └─ media/
      ├─ akaza's-love-theme.mid [3.68 KB]
      ├─ akaza.png [53.15 KB]
      ├─ akaza.svg [4.38 KB]
      └─ happy.png [6.98 MB]

The file extension/media/happy.png is large (6.98 MB)
```

## [1.0.1] - 2025-10-05
- Fixed editor unresponsiveness after extended use or heavy scrolling with snow-in-editor effect
   - Changed FPS from 15 to 8
   - Scrolling debounce
   - Add `dispose()`
- 12 files, 7.06 MB, 1.104.0
```
Done in 14ms
INFO  Files included in the VSIX:
akazas-love-1.0.0.vsix
├─ [Content_Types].xml
├─ extension.vsixmanifest
└─ extension/
   ├─ LICENSE.txt [1.06 KB]
   ├─ changelog.md [1.55 KB]
   ├─ package.json [10.66 KB]
   ├─ readme.md [2.42 KB]
   ├─ dist/
   │  ├─ extension.js [68.54 KB]
   │  └─ index.html [3.74 KB]
   └─ media/
      ├─ akaza's-love-theme.mid [3.68 KB]
      ├─ akaza.png [53.15 KB]
      ├─ akaza.svg [4.38 KB]
      └─ happy.png [6.98 MB]

The file extension/media/happy.png is large (6.98 MB)
```

### Note
- Not sure what caused the build up that made the vscode freeze since nothing seem strange when inspecting cpu/memory usage stats


## [1.0.0] - 2025-10-02
- Initial release 🚀
- Musical typing: keystrokes play MIDI notes or scales
- Animated snow: snowflakes fall in editor and webview
- Typing-driven snow: snow speed and density react to typing rate
- Configurable effects: enable/disable music and snow, adjust volume, density, color, speed, etc.
- Webview panel: dedicated panel for snow animation and debug console
- Live settings: all features update instantly when settings change
- Status bar integration: toggle features from the VS Code status bar
- 12 files, 7.06 MB, 1.104.0
```
Done in 328ms
INFO  Files included in the VSIX:
akazas-love-1.0.0.vsix
├─ [Content_Types].xml
├─ extension.vsixmanifest
└─ extension/
   ├─ LICENSE.txt [1.06 KB]
   ├─ changelog.md [1.36 KB]
   ├─ package.json [10.56 KB]
   ├─ readme.md [2.35 KB]
   ├─ dist/
   │  ├─ extension.js [68.18 KB]
   │  └─ index.html [3.74 KB]
   └─ media/
      ├─ akaza's-love-theme.mid [3.68 KB]
      ├─ akaza.png [53.15 KB]
      ├─ akaza.svg [4.38 KB]
      └─ happy.png [6.98 MB]

The file extension/media/happy.png is large (6.98 MB)
```

### Notes
Publishing commands:
```sh
npx vsce publish
npx ovsx publish
```
