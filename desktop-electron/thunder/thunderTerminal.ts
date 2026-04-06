/**
 * Thunder Compute — Terminal Window & PTY Management
 *
 * Opens a centered BrowserWindow with xterm.js connected to a node-pty
 * instance running powershell.exe. Automatically sends `tnr create` on open.
 */

import { spawn as spawnPty } from 'node-pty'
import type { IPty } from 'node-pty'
import { BrowserWindow, ipcMain, screen } from 'electron'
import path from 'path'

const PTY_BUFFER_MAX = 50 * 1024 // 50KB rolling buffer

type TerminalSession = {
  window: BrowserWindow
  pty: IPty
  outputBuffer: string
}

let activeTerminal: TerminalSession | null = null

function getTerminalHtmlPath(): string {
  return path.join(__dirname, 'thunder', 'terminal.html')
}

function getTerminalPreloadPath(): string {
  return path.join(__dirname, 'thunder', 'terminalPreload.cjs')
}

/**
 * Opens the terminal BrowserWindow centered on the primary display.
 * Spawns a node-pty powershell session and auto-sends `tnr create`.
 * Returns a handle to read the rolling output buffer.
 */
export function openTerminalWindow(
  parentWindow: BrowserWindow,
): TerminalSession {
  if (activeTerminal) {
    activeTerminal.window.focus()
    return activeTerminal
  }

  const primaryDisplay = screen.getPrimaryDisplay()
  const { width: displayWidth, height: displayHeight } =
    primaryDisplay.workAreaSize
  const winWidth = 800
  const winHeight = 520
  const x = Math.round((displayWidth - winWidth) / 2)
  const y = Math.round((displayHeight - winHeight) / 2)

  const win = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    x,
    y,
    resizable: false,
    frame: true,
    title: 'Thunder Compute \u2014 Create Session',
    modal: true,
    parent: parentWindow,
    backgroundColor: '#0d1117',
    show: false,
    webPreferences: {
      preload: getTerminalPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  // Spawn PTY
  const pty = spawnPty('powershell.exe', [], {
    name: 'xterm-256color',
    cols: 100,
    rows: 30,
    cwd: process.env.USERPROFILE ?? process.cwd(),
    env: process.env as Record<string, string>,
  })

  let outputBuffer = ''

  // Pipe PTY output to renderer and rolling buffer
  pty.onData(data => {
    outputBuffer += data
    if (outputBuffer.length > PTY_BUFFER_MAX) {
      outputBuffer = outputBuffer.slice(outputBuffer.length - PTY_BUFFER_MAX)
    }
    if (!win.isDestroyed()) {
      win.webContents.send('pty:data', data)
    }
  })

  const session: TerminalSession = { window: win, pty, outputBuffer: '' }

  // Use a getter so callers always see the latest buffer
  Object.defineProperty(session, 'outputBuffer', {
    get: () => outputBuffer,
    enumerable: true,
  })

  activeTerminal = session

  // IPC: renderer keystrokes → PTY
  const inputHandler = (_event: Electron.IpcMainInvokeEvent, data: string): void => {
    if (activeTerminal?.pty) {
      activeTerminal.pty.write(data)
    }
  }
  ipcMain.handle('pty:input', inputHandler)

  // IPC: renderer resize → PTY
  const resizeHandler = (
    _event: Electron.IpcMainInvokeEvent,
    cols: number,
    rows: number,
  ): void => {
    if (activeTerminal?.pty && cols > 0 && rows > 0) {
      activeTerminal.pty.resize(cols, rows)
    }
  }
  ipcMain.handle('pty:resize', resizeHandler)

  win.once('ready-to-show', () => {
    win.show()
    // Auto-send tnr create after a brief delay for shell init
    setTimeout(() => {
      pty.write('tnr create\r')
    }, 800)
  })

  win.on('closed', () => {
    cleanupTerminal()
    ipcMain.removeHandler('pty:input')
    ipcMain.removeHandler('pty:resize')
  })

  void win.loadFile(getTerminalHtmlPath())

  return session
}

/**
 * Writes a colored message to the terminal xterm, then closes after a delay.
 */
export function writeTransitionMessage(message: string): void {
  if (!activeTerminal) {
    return
  }
  const { pty } = activeTerminal
  // Write green separator directly to the PTY output stream via the window
  const green = '\x1b[32m'
  const reset = '\x1b[0m'
  const separator = `\r\n${green}${'─'.repeat(60)}\r\n${message}\r\n${'─'.repeat(60)}${reset}\r\n`
  if (!activeTerminal.window.isDestroyed()) {
    activeTerminal.window.webContents.send('pty:data', separator)
  }
  // Also push to pty buffer to not break detection
  void pty
}

/**
 * Closes the terminal window and kills the PTY process.
 */
export function closeTerminalWindow(): void {
  if (!activeTerminal) {
    return
  }
  if (!activeTerminal.window.isDestroyed()) {
    activeTerminal.window.close()
  }
}

function cleanupTerminal(): void {
  if (activeTerminal) {
    try {
      activeTerminal.pty.kill()
    } catch {
      // PTY may already be dead
    }
    activeTerminal = null
  }
}

/**
 * Returns the current rolling output buffer from the PTY, or empty string.
 */
export function getPtyOutputBuffer(): string {
  return activeTerminal?.outputBuffer ?? ''
}

/**
 * Returns true if a terminal window is currently open.
 */
export function isTerminalOpen(): boolean {
  return activeTerminal !== null && !activeTerminal.window.isDestroyed()
}
