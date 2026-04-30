import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';

// ── TensorBoard instance tracker ──────────────────────────────────────────────

interface TBInstance {
    pid: number;
    port: number;
    logdir: string;
    statusItem: vscode.StatusBarItem;
    process: cp.ChildProcess;
}

const instances = new Map<string, TBInstance>(); // keyed by logdir
let outputChannel: vscode.OutputChannel;

// ── Helpers ───────────────────────────────────────────────────────────────────

function findFreePort(start = 6006): Promise<number> {
    return new Promise((resolve, reject) => {
        const tryPort = (port: number) => {
            const server = net.createServer();
            server.once('error', () => tryPort(port + 1));
            server.once('listening', () => {
                server.close(() => resolve(port));
            });
            server.listen(port, '127.0.0.1');
        };
        tryPort(start);
    });
}

async function getPythonPath(): Promise<string | undefined> {
    const ext = vscode.extensions.getExtension('ms-python.python');
    if (!ext) { return undefined; }
    const api = await ext.activate();
    // Python extension API v2
    if (api?.environments?.getActiveEnvironmentPath) {
        const env = api.environments.getActiveEnvironmentPath();
        return env?.path ?? undefined;
    }
    // Legacy API
    if (api?.settings?.getExecutionDetails) {
        const details = api.settings.getExecutionDetails();
        return details?.execCommand?.[0] ?? undefined;
    }
    return undefined;
}

function stopInstance(logdir: string) {
    const inst = instances.get(logdir);
    if (!inst) { return; }
    inst.statusItem.dispose();
    try { inst.process.kill('SIGTERM'); } catch { /* already dead */ }
    instances.delete(logdir);
}

function makeStatusItem(logdir: string, port: number): vscode.StatusBarItem {
    const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    item.text = `$(graph) TensorBoard :${port}`;
    item.tooltip = `logdir: ${logdir}\nClick to stop`;
    item.command = {
        command: 'open-as-workspace.stopTensorBoard',
        arguments: [logdir],
        title: 'Stop TensorBoard'
    };
    item.show();
    return item;
}

// ── Compare state ─────────────────────────────────────────────────────────────

let compareSource: vscode.Uri | undefined;

// ── Duplicate helpers ─────────────────────────────────────────────────────────

/** Copy file/dir/symlink. Symlinks are copied as-is (not dereferenced). */
function copyEntry(src: string, dest: string): Promise<void> {
    return fs.promises.cp(src, dest, { recursive: true, verbatimSymlinks: true });
}

// ── Extension entry ───────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
    outputChannel = vscode.window.createOutputChannel('TensorBoard');
    context.subscriptions.push(outputChannel);

    // Open as Workspace
    context.subscriptions.push(
        vscode.commands.registerCommand(
            'open-as-workspace.openFolder',
            (uri: vscode.Uri) => {
                if (!uri) {
                    vscode.window.showErrorMessage('No folder selected.');
                    return;
                }
                vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
            }
        )
    );

    // Stop TensorBoard (called from status bar)
    context.subscriptions.push(
        vscode.commands.registerCommand(
            'open-as-workspace.stopTensorBoard',
            (logdir: string) => {
                stopInstance(logdir);
                vscode.window.showInformationMessage(`TensorBoard stopped (${path.basename(logdir)})`);
            }
        )
    );

    // Open TensorBoard Here
    context.subscriptions.push(
        vscode.commands.registerCommand(
            'open-as-workspace.openTensorBoard',
            async (uri: vscode.Uri) => {
                if (!uri) {
                    vscode.window.showErrorMessage('No folder selected.');
                    return;
                }
                const logdir = uri.fsPath;

                // Already running for this logdir?
                if (instances.has(logdir)) {
                    const inst = instances.get(logdir)!;
                    const action = await vscode.window.showInformationMessage(
                        `TensorBoard is already running at http://localhost:${inst.port}`,
                        'Open in Browser', 'Stop'
                    );
                    if (action === 'Open in Browser') {
                        const localUri = await vscode.env.asExternalUri(vscode.Uri.parse(`http://localhost:${inst.port}`));
                        vscode.env.openExternal(localUri);
                    } else if (action === 'Stop') {
                        stopInstance(logdir);
                    }
                    return;
                }

                // Resolve python
                let pythonPath = await getPythonPath();
                if (!pythonPath) {
                    pythonPath = process.platform === 'win32' ? 'python' : 'python3';
                    vscode.window.showWarningMessage(
                        'Could not detect active Python interpreter. Using system python.'
                    );
                }

                const port = await findFreePort(6006);

                outputChannel.appendLine(`\n[${new Date().toLocaleTimeString()}] Starting TensorBoard`);
                outputChannel.appendLine(`  python:  ${pythonPath}`);
                outputChannel.appendLine(`  logdir:  ${logdir}`);
                outputChannel.appendLine(`  port:    ${port}`);
                outputChannel.show(true);

                // Register port forwarding immediately so it's ready when tensorboard starts
                const externalUri = await vscode.env.asExternalUri(vscode.Uri.parse(`http://localhost:${port}`));
                outputChannel.appendLine(`  mapped:  ${externalUri}`);

                const proc = cp.spawn(
                    pythonPath,
                    ['-m', 'tensorboard.main', '--logdir', logdir, '--port', String(port), '--bind_all'],
                    { detached: false, stdio: 'pipe' }
                );

                const statusItem = makeStatusItem(logdir, port);

                const inst: TBInstance = {
                    pid: proc.pid ?? -1,
                    port,
                    logdir,
                    statusItem,
                    process: proc
                };
                instances.set(logdir, inst);

                // Pipe output to channel and watch for ready signal
                let ready = false;
                const onData = (data: Buffer) => {
                    const text = data.toString();
                    outputChannel.append(text);
                    if (!ready && text.includes('http://localhost')) {
                        ready = true;
                        vscode.env.openExternal(externalUri);
                    }
                };
                proc.stdout?.on('data', onData);
                proc.stderr?.on('data', onData);

                proc.on('exit', (code) => {
                    outputChannel.appendLine(`[exit] TensorBoard exited with code ${code}`);
                    if (instances.has(logdir)) {
                        stopInstance(logdir);
                        if (code !== 0 && code !== null) {
                            vscode.window.showErrorMessage(
                                `TensorBoard exited with code ${code}. See Output > TensorBoard for details.`,
                                'Show Output'
                            ).then(action => {
                                if (action === 'Show Output') { outputChannel.show(); }
                            });
                        }
                    }
                });

                context.subscriptions.push({ dispose: () => stopInstance(logdir) });
            }
        )
    );

    // Select for Compare
    context.subscriptions.push(
        vscode.commands.registerCommand(
            'open-as-workspace.selectForCompare',
            (uri: vscode.Uri) => {
                if (!uri) { return; }
                compareSource = uri;
                vscode.commands.executeCommand('setContext', 'open-as-workspace.hasCompareSource', true);
                vscode.window.setStatusBarMessage(`Selected for compare: ${path.basename(uri.fsPath)}`, 3000);
            }
        )
    );

    // Compare with Selected
    context.subscriptions.push(
        vscode.commands.registerCommand(
            'open-as-workspace.compareWithSelected',
            (uri: vscode.Uri) => {
                if (!uri) { return; }
                if (!compareSource) {
                    vscode.window.showErrorMessage('No file selected for compare yet.');
                    return;
                }
                const label = `${path.basename(compareSource.fsPath)} ↔ ${path.basename(uri.fsPath)}`;
                vscode.commands.executeCommand('vscode.diff', compareSource, uri, label);
            }
        )
    );

    // Insert Path to Terminal
    context.subscriptions.push(
        vscode.commands.registerCommand(
            'open-as-workspace.insertPathToTerminal',
            (uri: vscode.Uri) => {
                if (!uri) { return; }
                const terminal = vscode.window.activeTerminal;
                if (!terminal) { vscode.window.showErrorMessage('No active terminal.'); return; }
                terminal.sendText(uri.fsPath, false);
                terminal.show();
            }
        )
    );

    // Insert Relative Path to Terminal
    context.subscriptions.push(
        vscode.commands.registerCommand(
            'open-as-workspace.insertRelativePathToTerminal',
            (uri: vscode.Uri) => {
                if (!uri) { return; }
                const terminal = vscode.window.activeTerminal;
                if (!terminal) { vscode.window.showErrorMessage('No active terminal.'); return; }
                const wsFolder = vscode.workspace.getWorkspaceFolder(uri);
                const relative = wsFolder ? path.relative(wsFolder.uri.fsPath, uri.fsPath) : uri.fsPath;
                terminal.sendText(relative, false);
                terminal.show();
            }
        )
    );

    // Insert Stem to Terminal
    context.subscriptions.push(
        vscode.commands.registerCommand(
            'open-as-workspace.insertStemToTerminal',
            (uri: vscode.Uri) => {
                if (!uri) { return; }
                const terminal = vscode.window.activeTerminal;
                if (!terminal) { vscode.window.showErrorMessage('No active terminal.'); return; }
                const name = path.basename(uri.fsPath);
                const ext = path.extname(name);
                terminal.sendText(ext ? name.slice(0, -ext.length) : name, false);
                terminal.show();
            }
        )
    );

    // Insert Name to Terminal
    context.subscriptions.push(
        vscode.commands.registerCommand(
            'open-as-workspace.insertNameToTerminal',
            (uri: vscode.Uri) => {
                if (!uri) { return; }
                const terminal = vscode.window.activeTerminal;
                if (!terminal) { vscode.window.showErrorMessage('No active terminal.'); return; }
                terminal.sendText(path.basename(uri.fsPath), false);
                terminal.show();
            }
        )
    );

    // Copy Parent's Path
    context.subscriptions.push(
        vscode.commands.registerCommand(
            'open-as-workspace.copyParentPath',
            (uri: vscode.Uri) => {
                if (!uri) { return; }
                vscode.env.clipboard.writeText(path.dirname(uri.fsPath));
            }
        )
    );

    // Copy Stem (filename without last extension)
    context.subscriptions.push(
        vscode.commands.registerCommand(
            'open-as-workspace.copyStem',
            (uri: vscode.Uri) => {
                if (!uri) { return; }
                const name = path.basename(uri.fsPath);
                const ext = path.extname(name);
                vscode.env.clipboard.writeText(ext ? name.slice(0, -ext.length) : name);
            }
        )
    );

    // Copy Name (full filename)
    context.subscriptions.push(
        vscode.commands.registerCommand(
            'open-as-workspace.copyName',
            (uri: vscode.Uri) => {
                if (!uri) { return; }
                vscode.env.clipboard.writeText(path.basename(uri.fsPath));
            }
        )
    );

    // Duplicate
    context.subscriptions.push(
        vscode.commands.registerCommand(
            'open-as-workspace.duplicate',
            async (uri: vscode.Uri) => {
                if (!uri) {
                    vscode.window.showErrorMessage('No file selected.');
                    return;
                }
                const srcPath = uri.fsPath;
                const dir = path.dirname(srcPath);
                const name = path.basename(srcPath);

                const input = await vscode.window.showInputBox({
                    title: 'Duplicate',
                    prompt: 'New name',
                    value: name,
                    valueSelection: [0, name.length - path.extname(name).length],
                    validateInput: (value: string) => {
                        if (!value || value === name) { return 'Please enter a different name.'; }
                        return null;
                    },
                });
                if (input === undefined) { return; } // cancelled

                const destPath = path.join(dir, input);

                await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: `Duplicating "${name}" → "${input}"`,
                        cancellable: false,
                    },
                    async () => {
                        try {
                            await copyEntry(srcPath, destPath);
                        } catch (err: any) {
                            vscode.window.showErrorMessage(`Duplicate failed: ${err.message}`);
                        }
                    }
                );
            }
        )
    );
}

export function deactivate() {
    for (const logdir of instances.keys()) {
        stopInstance(logdir);
    }
}
