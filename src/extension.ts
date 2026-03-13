import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as os from 'os';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ServerDef {
    id: string;
    title: string;
    command: string;
}

interface RunningServer {
    terminal: vscode.Terminal;
    proc: cp.ChildProcess;
    ngrokUrl: string | null;
}

interface PanelState {
    servers: Array<{
        id: string;
        title: string;
        command: string;
        running: boolean;
        ngrokUrl: string | null;
    }>;
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const STORAGE_KEY  = 'laas.servers';
const NGROK_URL_RE = /https:\/\/[^\s]+(?:ngrok\.io|ngrok-free\.app|ngrok\.app)[^\s]*/i;

const DEFAULT_SERVERS: ServerDef[] = [
    { id: 'laravel', title: 'Laravel', command: 'cd cashier-master-api && php artisan serve' },
    { id: 'vite',    title: 'Vite',    command: 'cd cashier-master-front && npm run dev' },
    { id: 'ngrok',   title: 'ngrok',   command: 'ngrok http 8000' },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getNonce(): string {
    const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    return Array.from({ length: 32 }, () => c[Math.floor(Math.random() * c.length)]).join('');
}

function makeId(title: string): string {
    const base = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'server';
    return `${base}-${Date.now().toString(36)}`;
}

// ─── WebviewView Provider ─────────────────────────────────────────────────────

class LaasWebviewProvider implements vscode.WebviewViewProvider {
    public static readonly viewId = 'laas.panel';
    private view?: vscode.WebviewView;
    private pendingState?: PanelState;

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this.view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html  = buildHtml(getNonce(), getNonce());

        webviewView.webview.onDidReceiveMessage((msg: Record<string, unknown>) => {
            void vscode.commands.executeCommand('laas._msg', msg);
        });

        if (this.pendingState) {
            this.refresh(this.pendingState);
            this.pendingState = undefined;
        }
    }

    refresh(state: PanelState): void {
        if (!this.view) { this.pendingState = state; return; }
        void this.view.webview.postMessage({ type: 'state', state });
    }
}

// ─── Manager ──────────────────────────────────────────────────────────────────

class LaasManager {
    private readonly context:  vscode.ExtensionContext;
    private readonly provider: LaasWebviewProvider;
    private servers: ServerDef[] = [];
    private running = new Map<string, RunningServer>();

    private startBtn ?: vscode.StatusBarItem;
    private stopBtn  ?: vscode.StatusBarItem;
    private outputBtn?: vscode.StatusBarItem;

    constructor(ctx: vscode.ExtensionContext, provider: LaasWebviewProvider) {
        this.context  = ctx;
        this.provider = provider;
        this.servers  = this.loadServers();
    }

    init(): void {
        this.registerCommands();
        this.createStatusBar();
        this.pushState();
    }

    // ── Persistence ────────────────────────────────────────────────────────────

    private loadServers(): ServerDef[] {
        const stored = this.context.workspaceState.get<ServerDef[]>(STORAGE_KEY);
        if (Array.isArray(stored) && stored.length > 0) { return stored; }
        // Migrate from old VS Code settings if present
        const cfg = vscode.workspace.getConfiguration('laas');
        return [
            { id: 'laravel', title: 'Laravel', command: cfg.get<string>('laravelCommand', DEFAULT_SERVERS[0].command) },
            { id: 'vite',    title: 'Vite',    command: cfg.get<string>('viteCommand',    DEFAULT_SERVERS[1].command) },
            { id: 'ngrok',   title: 'ngrok',   command: cfg.get<string>('ngrokCommand',   DEFAULT_SERVERS[2].command) },
        ];
    }

    private async save(): Promise<void> {
        await this.context.workspaceState.update(STORAGE_KEY, this.servers);
    }

    // ── CRUD ──────────────────────────────────────────────────────────────────

    addServer(title: string, command: string): void {
        this.servers.push({ id: makeId(title), title: title.trim(), command: command.trim() });
        void this.save();
        this.pushState();
    }

    updateServer(id: string, title: string, command: string): void {
        const s = this.servers.find(x => x.id === id);
        if (!s) { return; }
        s.title   = title.trim();
        s.command = command.trim();
        void this.save();
        this.pushState();
    }

    async deleteServer(id: string): Promise<void> {
        const def = this.servers.find(s => s.id === id);
        if (!def) { return; }
        const ok = await vscode.window.showWarningMessage(
            `Delete "${def.title}"? It will be stopped if running.`,
            { modal: true }, 'Delete'
        );
        if (ok !== 'Delete') { return; }
        await this.stopById(id);
        this.servers = this.servers.filter(s => s.id !== id);
        void this.save();
        this.pushState();
    }

    // ── Server lifecycle ───────────────────────────────────────────────────────

    async startById(id: string): Promise<void> {
        const def = this.servers.find(s => s.id === id);
        if (!def) { return; }
        if (this.running.has(id)) {
            void vscode.window.showInformationMessage(`LaaS: ${def.title} is already running.`);
            return;
        }
        const r = this.spawnServer(def);
        this.running.set(id, r);
        // Do NOT call terminal.show() — process runs silently in the background.
        // Users can reveal the terminal via the "View Logs" button in the panel.
        this.pushState();
    }

    async stopById(id: string): Promise<void> {
        const r = this.running.get(id);
        if (!r) { return; }
        try { r.proc.kill(); } catch { /* */ }
        r.terminal.dispose();
        this.running.delete(id);
        this.pushState();
    }

    async startAll(): Promise<void> {
        await Promise.all(this.servers.map(s => this.startById(s.id)));
        void vscode.window.showInformationMessage('LaaS: Dev environment started.');
    }

    async stopAll(): Promise<void> {
        await Promise.all([...this.running.keys()].map(id => this.stopById(id)));
        void vscode.window.showInformationMessage('LaaS: All servers stopped.');
    }

    async restartAll(): Promise<void> {
        await this.stopAll();
        await new Promise<void>(r => setTimeout(r, 400));
        await this.startAll();
    }

    // ── Process spawning ──────────────────────────────────────────────────────

    private spawnServer(def: ServerDef): RunningServer {
        const manager = this;
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
        // Use the user's login shell (e.g. zsh) with -l (login) and -i (interactive)
        // so that ~/.zshrc is sourced and custom aliases / functions are available.
        const userShell = process.env.SHELL ?? '/bin/zsh';
        const proc = cp.spawn(userShell, ['-l', '-i', '-c', def.command], { cwd, env: { ...process.env } });

        let ngrokUrl: string | null = null;
        const writeEmitter = new vscode.EventEmitter<string>();
        const closeEmitter = new vscode.EventEmitter<number | void>();

        const write = (chunk: Buffer | string): void => {
            const text = chunk.toString();
            writeEmitter.fire(text.replace(/\r?\n/g, '\r\n'));
            const stripped = text.replace(/\x1b\[[0-9;]*m/g, '');
            const m = NGROK_URL_RE.exec(stripped);
            if (m && m[0] !== ngrokUrl) {
                ngrokUrl = m[0];
                const r = manager.running.get(def.id);
                if (r) { r.ngrokUrl = ngrokUrl; }
                manager.pushState();
            }
        };

        proc.stdout?.on('data', write);
        proc.stderr?.on('data', write);
        proc.on('error', err => writeEmitter.fire(`\r\n\x1b[31mError: ${err.message}\x1b[0m\r\n`));
        proc.on('exit', (code, signal) => {
            writeEmitter.fire(`\r\n\x1b[33mProcess exited (${code ?? signal ?? 0})\x1b[0m\r\n`);
            manager.running.delete(def.id);
            manager.pushState();
        });

        const pty: vscode.Pseudoterminal = {
            onDidWrite:  writeEmitter.event,
            onDidClose:  closeEmitter.event,
            open:        () => { writeEmitter.fire(`\x1b[36m$ ${def.command}\x1b[0m\r\n\r\n`); },
            close:       () => { try { proc.kill(); } catch { /**/ } closeEmitter.fire(); },
            handleInput: (d) => { if (d === '\x03') { try { proc.kill('SIGINT'); } catch { /**/ } } },
        };

        const terminal = vscode.window.createTerminal({ name: `LaaS — ${def.title}`, pty });
        return { terminal, proc, ngrokUrl };
    }

    // ── Commands ───────────────────────────────────────────────────────────────

    private registerCommands(): void {
        this.reg('laas.startAll',   async () => this.startAll());
        this.reg('laas.stopAll',    async () => this.stopAll());
        this.reg('laas.restartAll', async () => this.restartAll());
        this.reg('laas.showOutput', async () => this.showPicker());

        this.reg('laas._msg', async (...args: unknown[]) => {
            const msg = args[0] as Record<string, unknown>;
            const id = msg.id as string | undefined;
            switch (msg.type) {
                case 'startServer':   if (id) { await this.startById(id); }  break;
                case 'stopServer':    if (id) { await this.stopById(id); }   break;
                case 'saveServer':    if (id) { this.updateServer(id, msg.title as string, msg.command as string); } break;
                case 'addServer':     this.addServer(msg.title as string, msg.command as string); break;
                case 'deleteServer':  if (id) { await this.deleteServer(id); } break;
                case 'startAll':      await this.startAll();   break;
                case 'stopAll':       await this.stopAll();    break;
                case 'restartAll':    await this.restartAll(); break;
                case 'openUrl':       void vscode.env.openExternal(vscode.Uri.parse(msg.url as string)); break;
                case 'showTerminal':  if (id) { this.running.get(id)?.terminal.show(true); } break;
            }
        });
    }

    private reg(cmd: string, cb: (...args: unknown[]) => unknown): void {
        this.context.subscriptions.push(vscode.commands.registerCommand(cmd, cb));
    }

    private cfg<T>(key: string, def: T): T {
        return vscode.workspace.getConfiguration('laas').get<T>(key, def);
    }

    // ── Status bar ─────────────────────────────────────────────────────────────

    private createStatusBar(): void {
        const side = this.cfg<string>('statusBarAlignment', 'left') === 'right'
            ? vscode.StatusBarAlignment.Right : vscode.StatusBarAlignment.Left;

        this.startBtn  = this.makeBtn(side, 100, '$(play) LaaS',    'LaaS: Start All',   'laas.startAll');
        this.stopBtn   = this.makeBtn(side, 99,  '$(stop) LaaS',    'LaaS: Stop All',    'laas.stopAll');
        this.outputBtn = this.makeBtn(side, 98,  '$(terminal) LaaS','LaaS: Show Output', 'laas.showOutput');

        this.startBtn.show();
        this.outputBtn.show();
        this.context.subscriptions.push(this.startBtn, this.stopBtn, this.outputBtn);
    }

    private makeBtn(side: vscode.StatusBarAlignment, pri: number, text: string, tip: string, cmd: string): vscode.StatusBarItem {
        const b = vscode.window.createStatusBarItem(side, pri);
        b.text = text; b.tooltip = tip; b.command = cmd;
        return b;
    }

    private updateStatusBar(): void {
        const any = this.running.size > 0;
        if (this.startBtn)  { this.startBtn.color  = any ? '#4ade80' : undefined; }
        if (this.outputBtn) { this.outputBtn.color = any ? '#66c2ff' : undefined; }
        if (this.stopBtn) {
            if (any) { this.stopBtn.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground'); this.stopBtn.show(); }
            else     { this.stopBtn.backgroundColor = undefined; this.stopBtn.hide(); }
        }
    }

    // ── State ──────────────────────────────────────────────────────────────────

    private pushState(): void {
        this.updateStatusBar();
        this.provider.refresh({
            servers: this.servers.map(s => {
                const r = this.running.get(s.id);
                return { id: s.id, title: s.title, command: s.command, running: !!r, ngrokUrl: r?.ngrokUrl ?? null };
            }),
        });
    }

    private async showPicker(): Promise<void> {
        const items: vscode.QuickPickItem[] = [
            { label: '$(play) Start All',     description: 'Launch all services' },
            { label: '$(stop) Stop All',      description: 'Stop all services' },
            { label: '$(refresh) Restart All',description: 'Restart all services' },
            { kind: vscode.QuickPickItemKind.Separator, label: 'Terminals' },
            ...this.servers.map(s => ({ label: `$(terminal) ${s.title}`, description: this.running.has(s.id) ? 'running' : 'stopped' })),
        ];
        const p = await vscode.window.showQuickPick(items, { placeHolder: 'LaaS — pick an action' });
        if (!p) { return; }
        if (p.label === '$(play) Start All')      { await this.startAll();   return; }
        if (p.label === '$(stop) Stop All')       { await this.stopAll();    return; }
        if (p.label === '$(refresh) Restart All') { await this.restartAll(); return; }
        const def = this.servers.find(s => p.label === `$(terminal) ${s.title}`);
        if (def) { this.running.get(def.id)?.terminal.show(true); }
    }

    dispose(): void {
        for (const r of this.running.values()) {
            try { r.proc.kill(); } catch { /**/ }
            r.terminal.dispose();
        }
        this.running.clear();
    }
}

// ─── HTML ─────────────────────────────────────────────────────────────────────

function buildHtml(sn: string, scn: string): string {
    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${sn}'; script-src 'nonce-${scn}';">
<title>LaaS</title>
<style nonce="${sn}">
:root {
  --bg:       var(--vscode-editor-background);
  --border:   var(--vscode-panel-border);
  --fg:       var(--vscode-foreground);
  --muted:    var(--vscode-descriptionForeground);
  --input-bg: var(--vscode-input-background);
  --input-fg: var(--vscode-input-foreground);
  --input-br: var(--vscode-input-border, var(--border));
  --btn-bg:   var(--vscode-button-background);
  --btn-fg:   var(--vscode-button-foreground);
  --btn-hov:  var(--vscode-button-hoverBackground);
  --sec-bg:   var(--vscode-button-secondaryBackground);
  --sec-fg:   var(--vscode-button-secondaryForeground);
  --sec-hov:  var(--vscode-button-secondaryHoverBackground);
  --danger:   #dc2626;
  --danger-fg:#fff;
  --on:       #4ade80;
  --link:     var(--vscode-textLink-foreground);
  --r:        6px;
}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--fg);padding:8px 8px 16px;display:flex;flex-direction:column;gap:6px}
.hidden{display:none!important}
.sec{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);padding:6px 2px 2px}
.card{background:var(--bg);border:1px solid var(--border);border-radius:var(--r);padding:8px 10px;display:flex;flex-direction:column;gap:5px}
.card-head{display:flex;align-items:center;gap:6px}
.dot{width:8px;height:8px;border-radius:50%;background:#6b7280;flex-shrink:0;transition:background .2s}
.dot.on{background:var(--on);box-shadow:0 0 5px var(--on)}
.svc-name{font-weight:600;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.badge{font-size:10px;padding:1px 6px;border-radius:20px;background:#374151;color:#9ca3af}
.badge.on{background:var(--on);color:#000}
.btn-icon{background:none;border:none;color:var(--muted);cursor:pointer;font-size:13px;padding:2px 4px;border-radius:3px;flex-shrink:0;line-height:1}
.btn-icon:hover{color:var(--fg);background:var(--sec-bg)}
.cmd-preview{font-size:10px;color:var(--muted);font-family:monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 2px}
.row{display:flex;gap:5px}
button{border:none;border-radius:calc(var(--r) - 2px);cursor:pointer;font-size:11px;font-family:inherit;padding:4px 8px;transition:opacity .15s}
button:hover{opacity:.85}
button:active{opacity:.7}
button:disabled{opacity:.35;cursor:not-allowed}
.btn-primary{background:var(--btn-bg);color:var(--btn-fg);flex:1}
.btn-secondary{background:var(--sec-bg);color:var(--sec-fg);flex:1}
.btn-danger{background:var(--danger);color:var(--danger-fg)}
.ngrok-url{font-size:10px;color:var(--muted);display:flex;gap:4px;align-items:center;border-top:1px solid var(--border);padding-top:5px;word-break:break-all}
.ngrok-url a{color:var(--link);text-decoration:none;cursor:pointer}
.ngrok-url a:hover{text-decoration:underline}
.divider{height:1px;background:var(--border);margin:4px 0}
.form-group{display:flex;flex-direction:column;gap:3px}
label{font-size:10px;color:var(--muted)}
input,textarea{background:var(--input-bg);color:var(--input-fg);border:1px solid var(--input-br);border-radius:4px;padding:4px 6px;font-family:monospace;font-size:11px;width:100%;resize:vertical}
input:focus,textarea:focus{outline:1px solid var(--link);border-color:var(--link)}
.form-error{font-size:11px;color:#f87171}
.add-toggle-btn{width:100%;background:none;border:1px dashed var(--border);color:var(--muted);border-radius:var(--r);padding:6px;font-size:11px}
.add-toggle-btn:hover{border-color:var(--fg);color:var(--fg)}
.global-row{display:grid;grid-template-columns:1fr 1fr;gap:5px}
.global-row .btn-restart{grid-column:span 2}
</style>
</head>
<body>

<div class="sec">Services</div>
<div id="cards"></div>

<button class="add-toggle-btn" id="add-toggle">+ Add Service</button>
<div class="card hidden" id="add-form">
  <div class="form-group"><label>Name</label><input id="new-title" type="text" placeholder="Queue Worker"></div>
  <div class="form-group"><label>Command</label><textarea id="new-cmd" rows="2" placeholder="php artisan queue:work"></textarea></div>
  <div class="form-error hidden" id="add-err"></div>
  <div class="row">
    <button class="btn-primary" id="add-submit">+ Add</button>
    <button class="btn-secondary" id="add-cancel">Cancel</button>
  </div>
</div>

<div class="divider"></div>
<div class="sec">Actions</div>
<div class="global-row">
  <button class="btn-primary"  id="start-all">▶ Start All</button>
  <button class="btn-danger"   id="stop-all">■ Stop All</button>
  <button class="btn-secondary btn-restart" id="restart-all">↺ Restart All</button>
</div>

<script nonce="${scn}">
const vsc = acquireVsCodeApi();
function send(msg){ vsc.postMessage(msg); }

let editingId  = null;
let editDraft  = null;
let addOpen    = false;

function toggleAdd(){
  addOpen = !addOpen;
  document.getElementById('add-form').classList.toggle('hidden', !addOpen);
  document.getElementById('add-toggle').textContent = addOpen ? '✗ Cancel' : '+ Add Service';
  if(addOpen){ document.getElementById('new-title').focus(); }
}

function submitAdd(){
  const title = document.getElementById('new-title').value.trim();
  const cmd   = document.getElementById('new-cmd').value.trim();
  const err   = document.getElementById('add-err');
  if(!title){ err.textContent='Name is required'; err.classList.remove('hidden'); return; }
  if(!cmd)  { err.textContent='Command is required'; err.classList.remove('hidden'); return; }
  err.classList.add('hidden');
  send({type:'addServer', title, command: cmd});
  document.getElementById('new-title').value = '';
  document.getElementById('new-cmd').value   = '';
  addOpen = false;
  document.getElementById('add-form').classList.add('hidden');
  document.getElementById('add-toggle').textContent = '+ Add Service';
}

function toggleEdit(id){
  if(editingId === id){
    cancelEdit(id);
    return;
  }
  if(editingId){
    const prev = document.getElementById('ef-'+editingId);
    if(prev){ prev.classList.add('hidden'); }
  }
  editingId = id;
  const form = document.getElementById('ef-'+id);
  if(form){ form.classList.remove('hidden'); document.getElementById('et-'+id).focus(); }
}

function cancelEdit(id){
  const form = document.getElementById('ef-'+id);
  if(form){ form.classList.add('hidden'); }
  editingId = null;
  editDraft = null;
}

function saveEdit(id){
  const title = document.getElementById('et-'+id).value.trim();
  const cmd   = document.getElementById('ec-'+id).value.trim();
  if(!title || !cmd){ return; }
  send({type:'saveServer', id, title, command: cmd});
  editingId = null;
  editDraft = null;
}

function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function buildCard(s){
  const on = s.running;
  const urlRow = s.ngrokUrl
    ? '<div class="ngrok-url">🔗 <a href="#" data-url="'+esc(s.ngrokUrl)+'" class="ngrok-link">'+esc(s.ngrokUrl)+'</a></div>'
    : '';
  return \`
<div class="card" id="card-\${s.id}">
  <div class="card-head">
    <div class="dot \${on?'on':''}"></div>
    <span class="svc-name">\${esc(s.title)}</span>
    <span class="badge \${on?'on':''}">\${on?'running':'stopped'}</span>
    <button class="btn-icon" data-action="edit" data-id="\${s.id}" title="Edit">✎</button>
  </div>
  <div class="cmd-preview" title="\${esc(s.command)}">\${esc(s.command)}</div>
  <div class="row">
    <button class="btn-primary"   data-action="startServer"   data-id="\${s.id}" \${on?'disabled':''}\>▶ Start</button>
    <button class="btn-secondary" data-action="stopServer"    data-id="\${s.id}" \${!on?'disabled':''}\>■ Stop</button>
    <button class="btn-icon"      data-action="showTerminal"  data-id="\${s.id}" title="View Logs" style="\${on?'':'opacity:.3;pointer-events:none'}\" >🖥</button>
  </div>
  \${urlRow}
  <div class="card hidden" id="ef-\${s.id}">
    <div class="form-group"><label>Name</label><input id="et-\${s.id}" type="text" value="\${esc(s.title)}"></div>
    <div class="form-group"><label>Command</label><textarea id="ec-\${s.id}" rows="2">\${esc(s.command)}</textarea></div>
    <div class="row">
      <button class="btn-primary"   data-action="saveEdit"    data-id="\${s.id}">💾 Save</button>
      <button class="btn-secondary" data-action="cancelEdit"  data-id="\${s.id}">✗ Cancel</button>
      <button class="btn-danger"    data-action="deleteServer" data-id="\${s.id}">🗑</button>
    </div>
  </div>
</div>\`;
}

function applyState(state){
  // save draft before re-render
  if(editingId){
    const te = document.getElementById('et-'+editingId);
    const ce = document.getElementById('ec-'+editingId);
    if(te && ce){ editDraft = { title: te.value, command: ce.value }; }
  }

  const stillEditing = editingId && state.servers.some(s => s.id === editingId);
  if(!stillEditing){ editingId = null; editDraft = null; }

  document.getElementById('cards').innerHTML = state.servers.map(buildCard).join('');

  if(editingId){
    const form = document.getElementById('ef-'+editingId);
    if(form){
      form.classList.remove('hidden');
      if(editDraft){
        document.getElementById('et-'+editingId).value = editDraft.title;
        document.getElementById('ec-'+editingId).value = editDraft.command;
      }
    }
  }
}

// ── Static button wiring ────────────────────────────────────────────────────
document.getElementById('add-toggle').addEventListener('click', toggleAdd);
document.getElementById('add-submit').addEventListener('click', submitAdd);
document.getElementById('add-cancel').addEventListener('click', toggleAdd);
document.getElementById('start-all').addEventListener('click', () => send({type:'startAll'}));
document.getElementById('stop-all').addEventListener('click',  () => send({type:'stopAll'}));
document.getElementById('restart-all').addEventListener('click',() => send({type:'restartAll'}));

// ── Dynamic card buttons via event delegation ────────────────────────────────
document.getElementById('cards').addEventListener('click', function(e){
  const btn = e.target.closest('[data-action]');
  if(!btn){ return; }
  const action = btn.dataset.action;
  const id     = btn.dataset.id;
  switch(action){
    case 'startServer':  send({type:'startServer',  id}); break;
    case 'stopServer':   send({type:'stopServer',   id}); break;
    case 'deleteServer': send({type:'deleteServer', id}); break;
    case 'saveEdit':     saveEdit(id);   break;
    case 'cancelEdit':   cancelEdit(id); break;
    case 'edit':         toggleEdit(id); break;
    case 'openUrl':      send({type:'openUrl', url: btn.dataset.url}); e.preventDefault(); break;
    case 'showTerminal': send({type:'showTerminal', id}); break;
  }
});

window.addEventListener('message', ({data}) => {
  if(data.type === 'state'){ applyState(data.state); }
});
</script>
</body>
</html>`;
}

// ─── Entry points ─────────────────────────────────────────────────────────────

let manager: LaasManager | undefined;

export function activate(ctx: vscode.ExtensionContext): void {
    const provider = new LaasWebviewProvider();
    ctx.subscriptions.push(
        vscode.window.registerWebviewViewProvider(LaasWebviewProvider.viewId, provider, {
            webviewOptions: { retainContextWhenHidden: true },
        })
    );
    manager = new LaasManager(ctx, provider);
    manager.init();
    ctx.subscriptions.push({ dispose: () => { manager?.dispose(); manager = undefined; } });
}

export function deactivate(): void {
    manager?.dispose();
    manager = undefined;
}