import { contextBridge, ipcRenderer } from 'electron'
import type { JarvisBridge } from './preloadApi.js'

const api: JarvisBridge = {
  bootstrap: () => ipcRenderer.invoke('jarvis:bootstrap'),
  getConfig: () => ipcRenderer.invoke('jarvis:get-config'),
  saveConfig: config => ipcRenderer.invoke('jarvis:save-config', config),
  getShell: () => ipcRenderer.invoke('jarvis:get-shell'),
  saveShell: shell => ipcRenderer.invoke('jarvis:save-shell', shell),
  getFeatures: () => ipcRenderer.invoke('jarvis:get-features'),
  getModels: () => ipcRenderer.invoke('jarvis:get-models'),
  checkRemoteHealth: config =>
    ipcRenderer.invoke('jarvis:check-remote-health', { config }),
  startSession: config => ipcRenderer.invoke('jarvis:start-session', { config }),
  sendPrompt: content => ipcRenderer.invoke('jarvis:send-prompt', content),
  interruptSession: () => ipcRenderer.invoke('jarvis:interrupt-session'),
  stopSession: () => ipcRenderer.invoke('jarvis:stop-session'),
  clearTranscript: () => ipcRenderer.invoke('jarvis:clear-transcript'),
  respondToPermission: (requestId, decision) =>
    ipcRenderer.invoke('jarvis:respond-to-permission', requestId, decision),
  listCompanionProfiles: () =>
    ipcRenderer.invoke('jarvis:list-companion-profiles'),
  runCompanionAction: action =>
    ipcRenderer.invoke('jarvis:run-companion-action', action),
  createCompanionProfile: profile =>
    ipcRenderer.invoke('jarvis:create-companion-profile', profile),
  updateCompanionProfile: (profileId, profile) =>
    ipcRenderer.invoke('jarvis:update-companion-profile', profileId, profile),
  selectCompanionProfile: profileId =>
    ipcRenderer.invoke('jarvis:select-companion-profile', profileId),
  deleteCompanionProfile: profileId =>
    ipcRenderer.invoke('jarvis:delete-companion-profile', profileId),
  onEvent: listener => {
    const wrapped = (_event: unknown, payload: unknown) => {
      listener(payload as never)
    }
    ipcRenderer.on('jarvis:event', wrapped)
    return () => {
      ipcRenderer.off('jarvis:event', wrapped)
    }
  },
  onBackendState: listener => {
    const wrapped = (_event: unknown, payload: unknown) => {
      listener(payload as never)
    }
    ipcRenderer.on('jarvis:backend-state', wrapped)
    return () => {
      ipcRenderer.off('jarvis:backend-state', wrapped)
    }
  },
  minimizeWindow: () => ipcRenderer.invoke('jarvis:minimize-window'),
  maximizeWindow: () => ipcRenderer.invoke('jarvis:maximize-window'),
  closeWindow: () => ipcRenderer.invoke('jarvis:close-window'),

  // Thunder Compute
  thunderOpenTerminal: () => ipcRenderer.invoke('thunder:open-terminal'),
  thunderBeginAutomation: (instanceId, bridgeApiKey) =>
    ipcRenderer.invoke('thunder:begin-automation', instanceId, bridgeApiKey),
  thunderAbortAutomation: () => ipcRenderer.invoke('thunder:abort-automation'),
  thunderHealthCheck: (publicUrl, apiKey) =>
    ipcRenderer.invoke('thunder:health-check', publicUrl, apiKey),
  thunderCheckSession: instanceId =>
    ipcRenderer.invoke('thunder:check-session', instanceId),
  thunderForwardPort: () => ipcRenderer.invoke('thunder:forward-port'),
  thunderGetSteps: () => ipcRenderer.invoke('thunder:get-steps'),
  onThunderSessionDetected: listener => {
    const wrapped = (_event: unknown, payload: unknown) => {
      listener(payload as never)
    }
    ipcRenderer.on('thunder:session-detected', wrapped)
    return () => {
      ipcRenderer.off('thunder:session-detected', wrapped)
    }
  },
  onThunderStepUpdate: listener => {
    const wrapped = (_event: unknown, payload: unknown) => {
      listener(payload as never)
    }
    ipcRenderer.on('thunder:step-update', wrapped)
    return () => {
      ipcRenderer.off('thunder:step-update', wrapped)
    }
  },
  onThunderLogStream: listener => {
    const wrapped = (_event: unknown, payload: unknown) => {
      listener(payload as never)
    }
    ipcRenderer.on('thunder:log-stream', wrapped)
    return () => {
      ipcRenderer.off('thunder:log-stream', wrapped)
    }
  },
}

contextBridge.exposeInMainWorld('jarvis', api)
