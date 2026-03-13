# LaaS

**Lazy as a Service**

LaaS is a VS Code / Antigravity-compatible extension that gives you a **sidebar panel** and status bar buttons to start, stop, and inspect your local dev stack — Laravel, Vite, and ngrok.

## Features

- **Sidebar panel** in the Activity Bar with per-service cards:
  - 🟢 Live status indicator (green = running, grey = stopped)
  - ▶ Start / ■ Stop buttons per service
  - 🔗 ngrok public URL displayed automatically when detected
- **Status bar buttons** — Start All, Stop All, Show Output
- Separate named terminals for each service
- ngrok URL opens in browser with one click

## Default commands

| Service | Default command |
|---------|----------------|
| Laravel | `php artisan serve` |
| Vite    | `npm run dev` |
| ngrok   | `ngrok http 8000` |

## Extension settings

| Setting | Description | Default |
|---------|-------------|---------|
| `laas.laravelCommand` | Command to start Laravel | `php artisan serve` |
| `laas.viteCommand` | Command to start Vite | `npm run dev` |
| `laas.ngrokCommand` | Command to start ngrok | `ngrok http 8000` |
| `laas.autoShowOnStart` | Focus terminal on start | `false` |
| `laas.statusBarAlignment` | `"left"` or `"right"` | `"left"` |

## Example settings.json

```json
{
  "laas.laravelCommand": "php -d xdebug.mode=debug artisan serve",
  "laas.viteCommand": "npm run dev",
  "laas.ngrokCommand": "ngrok http 8000",
  "laas.autoShowOnStart": false,
  "laas.statusBarAlignment": "left"
}
```

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
