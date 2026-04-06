import { contextBridge, ipcRenderer } from 'electron'

export type ThunderTerminalBridge = {
  onPtyData(listener: (data: string) => void): () => void
  sendPtyInput(data: string): void
  sendPtyResize(cols: number, rows: number): void
}

const api: ThunderTerminalBridge = {
  onPtyData: listener => {
    const wrapped = (_event: unknown, data: string): void => {
      listener(data)
    }
    ipcRenderer.on('pty:data', wrapped)
    return () => {
      ipcRenderer.off('pty:data', wrapped)
    }
  },
  sendPtyInput: (data: string) => {
    void ipcRenderer.invoke('pty:input', data)
  },
  sendPtyResize: (cols: number, rows: number) => {
    void ipcRenderer.invoke('pty:resize', cols, rows)
  },
}

contextBridge.exposeInMainWorld('thunderTerminal', api)
