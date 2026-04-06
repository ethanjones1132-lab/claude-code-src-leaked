import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'

declare global {
  interface Window {
    thunderTerminal: {
      onPtyData(listener: (data: string) => void): () => void
      sendPtyInput(data: string): void
      sendPtyResize(cols: number, rows: number): void
    }
  }
}

const container = document.getElementById('terminal')
if (!container) {
  throw new Error('Terminal container not found')
}

const terminal = new Terminal({
  cursorBlink: true,
  fontSize: 14,
  fontFamily: "'Cascadia Code', 'Consolas', 'Courier New', monospace",
  theme: {
    background: '#0d1117',
    foreground: '#c9d1d9',
    cursor: '#58a6ff',
    cursorAccent: '#0d1117',
    selectionBackground: '#264f78',
    black: '#0d1117',
    red: '#ff7b72',
    green: '#3fb950',
    yellow: '#d29922',
    blue: '#58a6ff',
    magenta: '#bc8cff',
    cyan: '#39c5cf',
    white: '#c9d1d9',
    brightBlack: '#484f58',
    brightRed: '#ffa198',
    brightGreen: '#56d364',
    brightYellow: '#e3b341',
    brightBlue: '#79c0ff',
    brightMagenta: '#d2a8ff',
    brightCyan: '#56d4dd',
    brightWhite: '#f0f6fc',
  },
  allowProposedApi: true,
})

const fitAddon = new FitAddon()
terminal.loadAddon(fitAddon)
terminal.open(container)
fitAddon.fit()

// Pipe PTY data to xterm
window.thunderTerminal.onPtyData(data => {
  terminal.write(data)
})

// Pipe keystrokes to PTY
terminal.onData(data => {
  window.thunderTerminal.sendPtyInput(data)
})

// Send resize events
terminal.onResize(({ cols, rows }) => {
  window.thunderTerminal.sendPtyResize(cols, rows)
})

// Fit on window resize
window.addEventListener('resize', () => {
  fitAddon.fit()
})

// Initial fit after a tick to ensure layout is settled
requestAnimationFrame(() => {
  fitAddon.fit()
})
