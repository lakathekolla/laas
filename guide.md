
## Building

```bash
npm run compile   # one-off build
npm run watch     # watch mode
```

Press **F5** in VS Code to launch the Extension Development Host.

# 1. Install vsce (the VS Code Extension packaging tool)
npm install -g @vscode/vsce

# 2. Make sure the extension is compiled
cd /Users/noone/Desktop/Laas
npm run compile

# 3. Package it into a .vsix file
vsce package

# 4. Install it in VS Code
code --install-extension laas-0.1.0.vsix