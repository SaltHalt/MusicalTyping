# Akaza's Love
Musical Typing 🎶 and Falling Snow ❄️

Did you watch Demon Slayer: Kimetsu no Yaiba - The Movie: Infinity Castle?
→ If you did, you already know what this extension is about! 👺
<a href="https://marketplace.visualstudio.com/items?itemName=lanly-dev.akazas-love" target="_blank">
  <img src='https://code.visualstudio.com/favicon.ico' width='13'/>
</a>
<a href="https://open-vsx.org/extension/lanly-dev/akazas-love" target="_blank">
  <img src='https://open-vsx.org/favicon.ico' width='12'/>
</a>

## Features

❄️🌨️ Snow falls, each flake a memory aching in the heart \
🎹🎶 Keystrokes sing, melodies rising to warm the soul \
😢💔 Though inevitable tragedy may come, hope endures in every note \
🎆🤗 Cherish each precious moment, let happiness gently unfold

## Extension Settings

Akaza's Love contributes the following settings:

- `akazas-love.musicTyping` (boolean, default: true): Enable musical typing sounds.
- `akazas-love.snowInEditor` (boolean, default: true): Enable snowfall overlay in editors.
- `akazas-love.snowEditorConfigs` (object): Configure editor snow:
	- `colorLight` (string, default: #7bb3e6): Light theme snowflake color
	- `colorDark` (string, default: #ffffffcc): Dark theme snowflake color
	- `density` (number, default: 50): Number of snowflakes per editor
	- `maxColumns` (number, default: 160): Max columns for snow placement
	- `size` (number, default: 10): Snowflake size in pixels
	- `speed` (number, default: 5): Snowfall speed in lines/sec
- `akazas-love.snowPanelConfigs` (object): Configure webview panel snow:
	- `colorLight` (string, default: #7bb3e6): Light theme snowflake color
	- `colorDark` (string, default: #bcdfff): Dark theme snowflake color
	- `density` (number, default: 50): Number of snowflakes per panel
	- `backgroundColor` (string, default: null): Panel background color
- `akazas-love.typingDriven` (boolean, default: false): Enable typing-driven snow (one flake per keypress, speed by typing rate)
- `akazas-love.volume` (number, default: 0.1): Volume level for musical notes (0.0 to 1.0)

All settings can be changed live in your VS Code settings (user or workspace) and take effect instantly.

## Acknowledgement
The artwork used in this extension is not mine. All rights and credit go to the original artist(s).

## Release Notes

### 1.0.2
Minor updates

### 1.0.1
Fixed performance issues with snow-in-editor effect

### 1.0.0
Initial release of the extension

**Enjoy!**
