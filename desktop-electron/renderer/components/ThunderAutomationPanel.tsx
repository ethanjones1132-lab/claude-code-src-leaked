/**
 * Thunder Compute — Automation Panel
 *
 * Displays Phase 2 step progress with live log streaming.
 * Replaces the terminal window once session detection completes.
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type {
  ThunderStepId,
  ThunderStepUpdatePayload,
  ThunderLogStreamPayload,
} from '../../thunder/thunderTypes.js'

type StepDisplay = {
  id: ThunderStepId
  label: string
  state: 'pending' | 'active' | 'done' | 'error'
  startedAt: number | null
  error: string | null
}

type ThunderAutomationPanelProps = {
  instanceId: string
  bridgeApiKey: string
  onComplete: (publicUrl: string, instanceId: string) => void
  onAbort: () => void
}

export function ThunderAutomationPanel({
  instanceId,
  bridgeApiKey,
  onComplete,
  onAbort,
}: ThunderAutomationPanelProps): React.ReactElement {
  const [steps, setSteps] = useState<StepDisplay[]>([])
  const [logs, setLogs] = useState<string[]>([])
  const [activeStepLabel, setActiveStepLabel] = useState('')
  const [elapsedMs, setElapsedMs] = useState(0)
  const [errorStep, setErrorStep] = useState<StepDisplay | null>(null)
  const [completed, setCompleted] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const logEndRef = useRef<HTMLDivElement>(null)
  const autoScrollRef = useRef(true)
  const logContainerRef = useRef<HTMLDivElement>(null)

  // Initialize steps from main process
  useEffect(() => {
    void window.jarvis.thunderGetSteps().then(stepDefs => {
      setSteps(
        stepDefs.map(s => ({
          id: s.id,
          label: s.label,
          state: 'pending' as const,
          startedAt: null,
          error: null,
        })),
      )
    })
  }, [])

  // Subscribe to step updates
  useEffect(() => {
    const unsub = window.jarvis.onThunderStepUpdate(
      (payload: ThunderStepUpdatePayload) => {
        setSteps(prev =>
          prev.map(s => {
            if (s.id !== payload.stepId) {
              return s
            }
            const updated: StepDisplay = {
              ...s,
              state: payload.state,
              error: payload.error,
              startedAt:
                payload.state === 'active' ? Date.now() : s.startedAt,
            }
            if (payload.state === 'active') {
              setActiveStepLabel(s.label)
              setErrorStep(null)
            }
            if (payload.state === 'error') {
              setErrorStep(updated)
            }
            return updated
          }),
        )
      },
    )
    return unsub
  }, [])

  // Subscribe to log stream
  useEffect(() => {
    const unsub = window.jarvis.onThunderLogStream(
      (payload: ThunderLogStreamPayload) => {
        const lines = payload.text
          .split('\n')
          .filter(l => l.trim().length > 0)
        if (lines.length > 0) {
          setLogs(prev => {
            const next = [...prev, ...lines]
            return next.length > 500 ? next.slice(next.length - 500) : next
          })
        }
      },
    )
    return unsub
  }, [])

  // Elapsed time ticker for active step
  useEffect(() => {
    const timer = setInterval(() => {
      const active = steps.find(s => s.state === 'active')
      if (active?.startedAt) {
        setElapsedMs(Date.now() - active.startedAt)
      }
    }, 1000)
    return () => clearInterval(timer)
  }, [steps])

  // Auto-scroll logs
  useLayoutEffect(() => {
    if (autoScrollRef.current && logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [logs])

  // Handle log scroll to disable auto-scroll when user scrolls up
  function handleLogScroll(): void {
    const el = logContainerRef.current
    if (!el) {
      return
    }
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    autoScrollRef.current = atBottom
  }

  // Start automation on mount
  useEffect(() => {
    void runAutomation()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function runAutomation(): Promise<void> {
    setRetrying(false)
    setErrorStep(null)
    const result = await window.jarvis.thunderBeginAutomation(
      instanceId,
      bridgeApiKey,
    )
    if (result.ok && result.publicUrl && result.instanceId) {
      setCompleted(true)
      onComplete(result.publicUrl, result.instanceId)
    }
    // Errors are handled via step-update events
  }

  function handleRetry(): void {
    setRetrying(true)
    // Reset all steps back to pending
    setSteps(prev =>
      prev.map(s => ({
        ...s,
        state: 'pending' as const,
        error: null,
        startedAt: null,
      })),
    )
    setLogs([])
    void runAutomation()
  }

  function handleAbort(): void {
    if (
      !window.confirm(
        'This will not terminate the Thunder instance. You will continue to be billed. Terminate manually at thundercompute.com.',
      )
    ) {
      return
    }
    void window.jarvis.thunderAbortAutomation()
    onAbort()
  }

  function formatElapsed(ms: number): string {
    const secs = Math.floor(ms / 1000)
    const mins = Math.floor(secs / 60)
    const s = secs % 60
    return mins > 0 ? `${mins}m ${s}s` : `${s}s`
  }

  // Determine vLLM loading status for special display
  const vllmStep = steps.find(s => s.id === 'poll-vllm')
  const isVllmLoading = vllmStep?.state === 'active'
  const lastLogLine = logs.length > 0 ? logs[logs.length - 1] : ''

  return (
    <div style={panelStyle}>
      <div style={headerStyle}>
        <div style={titleRowStyle}>
          <span style={titleStyle}>Thunder Compute</span>
          <span style={instanceBadgeStyle}>{instanceId}</span>
        </div>
        {activeStepLabel && !completed && !errorStep && (
          <div style={activeStepRowStyle}>
            <span style={pulseStyle} />
            <span style={activeStepLabelStyle}>{activeStepLabel}</span>
            <span style={elapsedStyle}>{formatElapsed(elapsedMs)}</span>
          </div>
        )}
        {isVllmLoading && lastLogLine && (
          <div style={vllmStatusStyle}>
            Model loading &mdash; {lastLogLine.slice(0, 120)}
          </div>
        )}
        {completed && (
          <div style={successBannerStyle}>
            Session active. Jarvis is connected.
          </div>
        )}
      </div>

      {/* Step progress */}
      <div style={stepsContainerStyle}>
        {steps.map(step => (
          <div key={step.id} style={stepRowStyle}>
            <span style={stepIconStyle(step.state)}>
              {step.state === 'done'
                ? '\u2713'
                : step.state === 'error'
                  ? '\u2717'
                  : step.state === 'active'
                    ? '\u25CF'
                    : '\u25CB'}
            </span>
            <span
              style={{
                ...stepLabelStyle,
                color:
                  step.state === 'active'
                    ? 'var(--accent-strong)'
                    : step.state === 'done'
                      ? 'var(--success)'
                      : step.state === 'error'
                        ? 'var(--danger)'
                        : 'var(--muted)',
              }}
            >
              {step.label}
            </span>
          </div>
        ))}
      </div>

      {/* Error panel */}
      {errorStep && (
        <div style={errorPanelStyle}>
          <div style={errorTitleStyle}>
            {errorStep.label} failed
          </div>
          <div style={errorMessageStyle}>{errorStep.error}</div>
          <div style={errorActionsStyle}>
            <button
              style={retryButtonStyle}
              onClick={handleRetry}
              disabled={retrying}
            >
              {retrying ? 'Retrying...' : 'Retry Step'}
            </button>
            <button style={abortButtonStyle} onClick={handleAbort}>
              Abort Session
            </button>
          </div>
        </div>
      )}

      {/* Log pane */}
      <div
        ref={logContainerRef}
        style={logPaneStyle}
        onScroll={handleLogScroll}
      >
        {logs.map((line, i) => (
          <div key={i} style={logLineStyle}>
            {line}
          </div>
        ))}
        <div ref={logEndRef} />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Inline styles using Jarvis design tokens
// ---------------------------------------------------------------------------

const panelStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  background: 'var(--bg-2)',
  borderRadius: 'var(--radius-lg)',
  border: '1px solid var(--line)',
  overflow: 'hidden',
}

const headerStyle: React.CSSProperties = {
  padding: '20px 24px 16px',
  borderBottom: '1px solid var(--line)',
}

const titleRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
}

const titleStyle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 600,
  color: 'var(--text)',
}

const instanceBadgeStyle: React.CSSProperties = {
  fontSize: 12,
  fontFamily: "'Cascadia Code', 'Consolas', monospace",
  padding: '3px 10px',
  borderRadius: 'var(--radius-sm)',
  background: 'var(--accent-soft)',
  color: 'var(--accent-strong)',
}

const activeStepRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  marginTop: 10,
}

const pulseStyle: React.CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: '50%',
  background: 'var(--accent)',
  animation: 'pulse 1.5s ease-in-out infinite',
}

const activeStepLabelStyle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 500,
  color: 'var(--accent-strong)',
}

const elapsedStyle: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--muted)',
  marginLeft: 'auto',
}

const vllmStatusStyle: React.CSSProperties = {
  marginTop: 8,
  fontSize: 12,
  color: 'var(--warning)',
  fontFamily: "'Cascadia Code', 'Consolas', monospace",
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}

const successBannerStyle: React.CSSProperties = {
  marginTop: 10,
  fontSize: 14,
  fontWeight: 600,
  color: 'var(--success)',
}

const stepsContainerStyle: React.CSSProperties = {
  padding: '12px 24px',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  borderBottom: '1px solid var(--line)',
  maxHeight: 260,
  overflowY: 'auto',
}

const stepRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  fontSize: 13,
}

function stepIconStyle(
  state: 'pending' | 'active' | 'done' | 'error',
): React.CSSProperties {
  return {
    width: 18,
    textAlign: 'center',
    fontSize: 14,
    fontWeight: 700,
    color:
      state === 'done'
        ? 'var(--success)'
        : state === 'error'
          ? 'var(--danger)'
          : state === 'active'
            ? 'var(--accent)'
            : 'var(--muted)',
  }
}

const stepLabelStyle: React.CSSProperties = {
  fontSize: 13,
}

const errorPanelStyle: React.CSSProperties = {
  margin: '12px 24px',
  padding: '14px 18px',
  background: 'rgba(255, 106, 134, 0.08)',
  borderRadius: 'var(--radius-sm)',
  border: '1px solid rgba(255, 106, 134, 0.24)',
}

const errorTitleStyle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  color: 'var(--danger)',
  marginBottom: 8,
}

const errorMessageStyle: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--muted-strong)',
  fontFamily: "'Cascadia Code', 'Consolas', monospace",
  whiteSpace: 'pre-wrap',
  maxHeight: 100,
  overflow: 'auto',
  marginBottom: 12,
}

const errorActionsStyle: React.CSSProperties = {
  display: 'flex',
  gap: 10,
}

const retryButtonStyle: React.CSSProperties = {
  padding: '8px 18px',
  fontSize: 13,
  fontWeight: 600,
  borderRadius: 'var(--radius-sm)',
  background: 'var(--accent)',
  color: '#fff',
  border: 'none',
  cursor: 'pointer',
}

const abortButtonStyle: React.CSSProperties = {
  padding: '8px 18px',
  fontSize: 13,
  fontWeight: 600,
  borderRadius: 'var(--radius-sm)',
  background: 'rgba(255, 106, 134, 0.16)',
  color: 'var(--danger)',
  border: '1px solid rgba(255, 106, 134, 0.24)',
  cursor: 'pointer',
}

const logPaneStyle: React.CSSProperties = {
  flex: 1,
  padding: '12px 24px',
  overflowY: 'auto',
  fontFamily: "'Cascadia Code', 'Consolas', monospace",
  fontSize: 11,
  lineHeight: 1.6,
  color: 'var(--muted)',
  background: 'var(--bg)',
}

const logLineStyle: React.CSSProperties = {
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
}
