/**
 * Thunder Compute — Phase 1 Session Detection
 *
 * Polls `tnr status` to detect when a new instance reaches running state.
 * Uses pty output as a corroborating signal to increase poll frequency.
 */

import { exec } from 'child_process'
import { getPtyOutputBuffer } from './thunderTerminal.js'

type TnrInstance = {
  id: string
  status: string
}

type DetectionState = {
  baselineIds: Set<string>
  pollInterval: ReturnType<typeof setInterval> | null
  fastPolling: boolean
  resolved: boolean
  onDetected: ((instanceId: string) => void) | null
}

const state: DetectionState = {
  baselineIds: new Set(),
  pollInterval: null,
  fastPolling: false,
  resolved: false,
  onDetected: null,
}

/**
 * Parse `tnr status` output into instance list.
 * Format varies — we look for lines with instance IDs and status keywords.
 */
function parseTnrStatus(stdout: string): TnrInstance[] {
  const instances: TnrInstance[] = []
  const lines = stdout.split('\n')

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('─') || trimmed.startsWith('=')) {
      continue
    }

    // Try to match table-like rows: ID  | status | ...
    // Common patterns: "i-abc123  running  gpu-type ..."
    // or tabular: "0  i-abc123  running"
    const idMatch = trimmed.match(
      /\b(i-[a-zA-Z0-9]+)\b/,
    )
    if (!idMatch) {
      continue
    }

    const id = idMatch[1]
    const lowerLine = trimmed.toLowerCase()
    let status = 'unknown'
    if (
      lowerLine.includes('running') ||
      lowerLine.includes('active') ||
      lowerLine.includes('online')
    ) {
      status = 'running'
    } else if (
      lowerLine.includes('creating') ||
      lowerLine.includes('pending') ||
      lowerLine.includes('starting')
    ) {
      status = 'starting'
    } else if (
      lowerLine.includes('stopped') ||
      lowerLine.includes('terminated')
    ) {
      status = 'stopped'
    }

    instances.push({ id, status })
  }

  return instances
}

/**
 * Execute `tnr status` and return parsed instances.
 */
function pollTnrStatus(): Promise<TnrInstance[]> {
  return new Promise(resolve => {
    exec('tnr status', { timeout: 15_000 }, (error, stdout) => {
      if (error) {
        resolve([])
        return
      }
      resolve(parseTnrStatus(stdout))
    })
  })
}

/**
 * Check if PTY output suggests the user is near completion of the wizard.
 * Used as a corroborating signal to increase poll frequency.
 */
function checkPtyForCompletionHints(): boolean {
  const buffer = getPtyOutputBuffer()
  if (!buffer) {
    return false
  }

  const lower = buffer.toLowerCase()
  return (
    lower.includes('create instance') ||
    lower.includes('mode:') ||
    lower.includes('gpu type:') ||
    lower.includes('disk size:') ||
    lower.includes('✓')
  )
}

/**
 * Start the detection loop.
 * Captures baseline tnr status, then polls for new running instances.
 *
 * @param onDetected - Called with the new instance ID when detection succeeds
 * @returns Cleanup function to stop detection
 */
export async function startDetection(
  onDetected: (instanceId: string) => void,
): Promise<() => void> {
  // Reset state
  state.resolved = false
  state.fastPolling = false
  state.onDetected = onDetected

  // Capture baseline
  const baselineInstances = await pollTnrStatus()
  state.baselineIds = new Set(baselineInstances.map(inst => inst.id))

  // Start polling at 6s intervals
  const runPoll = async (): Promise<void> => {
    if (state.resolved) {
      return
    }

    // Check PTY hints to potentially switch to fast polling
    if (!state.fastPolling && checkPtyForCompletionHints()) {
      state.fastPolling = true
      // Restart interval at faster rate
      if (state.pollInterval) {
        clearInterval(state.pollInterval)
      }
      state.pollInterval = setInterval(() => void runPoll(), 2_000)
    }

    const instances = await pollTnrStatus()
    for (const inst of instances) {
      if (
        inst.status === 'running' &&
        !state.baselineIds.has(inst.id)
      ) {
        // New running instance detected
        state.resolved = true
        if (state.pollInterval) {
          clearInterval(state.pollInterval)
          state.pollInterval = null
        }
        state.onDetected?.(inst.id)
        return
      }
    }
  }

  state.pollInterval = setInterval(() => void runPoll(), 6_000)
  // Run once immediately
  void runPoll()

  return () => {
    state.resolved = true
    if (state.pollInterval) {
      clearInterval(state.pollInterval)
      state.pollInterval = null
    }
  }
}
