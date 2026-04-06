/**
 * Thunder Compute — IPC Handler Registration
 *
 * Registers all Thunder-related IPC channels in the main process.
 * Orchestrates the Phase 1 → Phase 2 flow.
 */

import { exec } from 'child_process'
import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import {
  openTerminalWindow,
  writeTransitionMessage,
  closeTerminalWindow,
} from './thunderTerminal.js'
import { startDetection } from './thunderDetection.js'
import {
  runAutomation,
  type AutomationResult,
} from './thunderAutomation.js'
import {
  THUNDER_STEPS,
  type ThunderStepId,
  type ThunderStepState,
} from './thunderTypes.js'

let detectionCleanup: (() => void) | null = null
let automationAbort: AbortController | null = null

/**
 * Check if a Thunder instance from a previous session is still running.
 * Returns the instance ID if running, null otherwise.
 */
export function checkExistingSession(instanceId: string): Promise<string | null> {
  return new Promise(resolve => {
    if (!instanceId) {
      resolve(null)
      return
    }
    exec('tnr status', { timeout: 15_000 }, (error, stdout) => {
      if (error) {
        resolve(null)
        return
      }
      const lower = stdout.toLowerCase()
      if (
        stdout.includes(instanceId) &&
        (lower.includes('running') ||
          lower.includes('active') ||
          lower.includes('online'))
      ) {
        resolve(instanceId)
      } else {
        resolve(null)
      }
    })
  })
}

/**
 * Register all Thunder IPC handlers.
 * Must be called once from main process initialization.
 */
export function registerThunderIpc(getMainWindow: () => BrowserWindow | null): void {
  // Open the terminal window and start Phase 1 detection
  ipcMain.handle('thunder:open-terminal', async () => {
    const mainWin = getMainWindow()
    if (!mainWin) {
      throw new Error('Main window not available')
    }

    openTerminalWindow(mainWin)

    // Start detection polling
    detectionCleanup = await startDetection((instanceId: string) => {
      // Transition: show message in terminal, close, notify renderer
      writeTransitionMessage('Session detected \u2014 Jarvis is taking over...')

      setTimeout(() => {
        closeTerminalWindow()
        const win = getMainWindow()
        if (win && !win.isDestroyed()) {
          win.webContents.send('thunder:session-detected', { instanceId })
        }
      }, 1500)
    })

    return { ok: true }
  })

  // Begin Phase 2 automation
  ipcMain.handle(
    'thunder:begin-automation',
    async (_event, instanceId: string, bridgeApiKey: string) => {
      const mainWin = getMainWindow()
      if (!mainWin) {
        throw new Error('Main window not available')
      }

      automationAbort = new AbortController()

      const emitter = {
        updateStep(
          stepId: ThunderStepId,
          state: ThunderStepState,
          error: string | null,
        ): void {
          if (!mainWin.isDestroyed()) {
            mainWin.webContents.send('thunder:step-update', {
              stepId,
              state,
              error,
            })
          }
        },
        log(source: string, text: string): void {
          if (!mainWin.isDestroyed()) {
            mainWin.webContents.send('thunder:log-stream', {
              source,
              text,
            })
          }
        },
      }

      try {
        const result: AutomationResult = await runAutomation(
          instanceId,
          bridgeApiKey,
          mainWin,
          emitter,
          automationAbort.signal,
        )

        // Mark save-config as done
        emitter.updateStep('save-config', 'done', null)

        return {
          ok: true,
          publicUrl: result.publicUrl,
          instanceId: result.instanceId,
        }
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }
      }
    },
  )

  // Abort automation
  ipcMain.handle('thunder:abort-automation', () => {
    automationAbort?.abort()
    automationAbort = null
    detectionCleanup?.()
    detectionCleanup = null
    return { ok: true }
  })

  // Run health check on a public URL (for resume flow)
  ipcMain.handle(
    'thunder:health-check',
    async (_event, publicUrl: string, apiKey: string) => {
      try {
        const response = await fetch(`${publicUrl}/healthz`, {
          headers: { 'X-Api-Key': apiKey },
          signal: AbortSignal.timeout(10_000),
        })
        return { ok: response.ok }
      } catch {
        return { ok: false }
      }
    },
  )

  // Check existing session for resume flow
  ipcMain.handle(
    'thunder:check-session',
    async (_event, instanceId: string) => {
      const result = await checkExistingSession(instanceId)
      return { running: result !== null, instanceId: result }
    },
  )

  // Forward a port (for resume flow, Step 4)
  ipcMain.handle('thunder:forward-port', async () => {
    return new Promise(resolve => {
      exec('tnr ports forward 0 --add 8787', { timeout: 30_000 }, error => {
        if (error) {
          resolve({ ok: false, error: error.message })
          return
        }
        resolve({ ok: true })
      })
    })
  })

  // Get Thunder steps list for UI initialization
  ipcMain.handle('thunder:get-steps', () => {
    return THUNDER_STEPS
  })
}
