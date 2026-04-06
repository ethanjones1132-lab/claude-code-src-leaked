import React, {
  startTransition,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { LauncherConfig } from '../../desktop-app/config.js'
import type {
  DesktopBuddyProfile,
  DesktopBuddyProfileDraft,
  DesktopEvent,
  DesktopFeatureSnapshot,
  DesktopRuntimeState,
  DesktopShellPayload,
  DesktopView,
  ModelCatalogResponse,
  PendingPermission,
  RemoteBridgeHealth,
  SnapshotEvent,
  StatusTone,
} from '../../desktop-app/types.js'
import type {
  JarvisBootstrapPayload,
  JarvisBridge,
  JarvisCompanionPayload,
} from '../preloadApi.js'
import { ThunderAutomationPanel } from './components/ThunderAutomationPanel.js'

declare global {
  interface Window {
    jarvis: JarvisBridge
  }
}

type AugmentedDesktopEvent = DesktopEvent & { id: number }

type TranscriptDetail = {
  title: string
  body: string
}

type TranscriptEntry = {
  id: string
  kind: 'message' | 'timeline'
  role?: 'user' | 'assistant'
  speaker?: string
  label?: string
  tone?: StatusTone
  body: string
  chips: string[]
  details: TranscriptDetail[]
}

type ConfigNotice = {
  tone: StatusTone
  message: string
}

const MAX_TRANSCRIPT_EVENTS = 320
const NAV_ITEMS: Array<{ id: DesktopView; label: string; glyph: string }> = [
  { id: 'chat', label: 'Chat', glyph: 'CH' },
  { id: 'autodream', label: 'AutoDream', glyph: 'AD' },
  { id: 'memory', label: 'Memory', glyph: 'ME' },
  { id: 'integrations', label: 'Integrations', glyph: 'AP' },
  { id: 'companion', label: 'Companion', glyph: 'BD' },
]

const DEFAULT_CONFIG: LauncherConfig = {
  workspacePath: '',
  backend: 'remote-glm',
  anthropicApiKey: '',
  anthropicBaseUrl: '',
  anthropicModel: 'claude-3-7-sonnet-20250219',
  ollamaBaseUrl: 'http://localhost:11434/v1',
  ollamaModel: '',
  remoteGlmBaseUrl: '',
  remoteGlmApiKey: '',
  remoteGlmModel: 'gpt-oss-auto',
  coordinatorMode: false,
  disableToolsForLocal: true,
  enableExperimentalLocalTools: false,
  disableNonessentialTraffic: true,
  disableThinkingForLocal: true,
  appendSystemPrompt: '',
  thunderInstanceId: '',
  thunderPublicUrl: '',
  thunderSessionActive: false,
}

const DEFAULT_SHELL: DesktopShellPayload = {
  uiState: {
    activeView: 'chat',
    advancedSettingsOpen: false,
    selectedIntegrationId: null,
  },
  integrations: [],
}

const IDLE_RUNTIME: DesktopRuntimeState = {
  running: false,
  busy: false,
  label: 'Idle',
  tone: 'idle',
  backend: null,
  mode: 'idle',
  model: '',
  workspacePath: '',
  sessionId: null,
}

const DEFAULT_BUDDY_DRAFT: DesktopBuddyProfileDraft = {
  name: '',
  personality: '',
  species: 'duck',
  eye: '.',
  hat: 'none',
  shiny: false,
  rarity: 'common',
}

function laneLabel(value: string): string {
  if (!value || value === 'gpt-oss-auto') {
    return 'Auto'
  }
  if (value === 'gpt-oss-120b' || value === '120b') {
    return '120B'
  }
  if (value === 'gpt-oss-20b' || value === '20b') {
    return '20B'
  }
  return value
}

function formatDateTime(value: string | number | null | undefined): string {
  if (!value) {
    return 'Unknown'
  }
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? 'Unknown'
    : date.toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
}

function titleCase(value: string): string {
  if (!value) {
    return ''
  }
  return value[0]!.toUpperCase() + value.slice(1)
}

function stringifyForDetail(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return ''
  }
  return content
    .map(block => {
      if (!block || typeof block !== 'object') {
        return ''
      }
      if ('type' in block && block.type === 'text' && typeof block.text === 'string') {
        return block.text
      }
      if (
        'type' in block &&
        block.type === 'connector_text' &&
        typeof block.connector_text === 'string'
      ) {
        return block.connector_text
      }
      if (
        'type' in block &&
        (block.type === 'thinking' || block.type === 'tool_result')
      ) {
        return ''
      }
      return typeof (block as { content?: unknown }).content === 'string'
        ? ((block as { content: string }).content ?? '')
        : ''
    })
    .filter(Boolean)
    .join('\n\n')
    .trim()
}

function extractBlocksByType(content: unknown, type: string): Array<Record<string, any>> {
  if (!Array.isArray(content)) {
    return []
  }
  return content.filter(
    block => Boolean(block) && typeof block === 'object' && block.type === type,
  ) as Array<Record<string, any>>
}

function extractToolResults(content: unknown): TranscriptDetail[] {
  if (!Array.isArray(content)) {
    return []
  }
  return content
    .filter(block => block && typeof block === 'object' && block.type === 'tool_result')
    .map(block => ({
      title: `Tool result${block.tool_use_id ? ` ${block.tool_use_id}` : ''}`,
      body: stringifyForDetail(block.content ?? block),
    }))
}

function summarizeUnknownMessage(message: Record<string, any>): string {
  if (typeof message.message === 'string') {
    return message.message
  }
  if (typeof message.content === 'string') {
    return message.content
  }
  if (typeof message.subtype === 'string') {
    return `Event subtype: ${message.subtype}`
  }
  return 'A runtime event was received.'
}

function normalizeUserEntry(
  id: number,
  message: Record<string, any>,
): TranscriptEntry[] {
  const content = message.message?.content ?? message.content ?? ''
  const text = extractTextContent(content)
  const details = extractToolResults(content)
  return [
    {
      id: `user-${id}`,
      kind: 'message',
      role: 'user',
      speaker: 'You',
      body: text || 'Sent a user message.',
      chips: details.length > 0 ? ['tool result'] : [],
      details,
    },
  ]
}

function normalizeAssistantEntry(
  id: number,
  message: Record<string, any>,
): TranscriptEntry[] {
  const content = message.message?.content ?? message.content ?? []
  const text =
    typeof message.content === 'string' ? message.content : extractTextContent(content)
  const thinkingBlocks = extractBlocksByType(content, 'thinking')
  const toolUses = extractBlocksByType(content, 'tool_use').concat(
    extractBlocksByType(content, 'server_tool_use'),
  )
  const redactedThinking = extractBlocksByType(content, 'redacted_thinking')
  const details: TranscriptDetail[] = []

  if (thinkingBlocks.length > 0) {
    details.push({
      title: 'Thinking',
      body: thinkingBlocks
        .map(block => block.thinking || block.text || stringifyForDetail(block))
        .join('\n\n'),
    })
  }
  if (redactedThinking.length > 0) {
    details.push({
      title: 'Redacted thinking',
      body: `Jarvis received ${redactedThinking.length} redacted thinking block${redactedThinking.length === 1 ? '' : 's'}.`,
    })
  }
  for (const tool of toolUses) {
    details.push({
      title: `Tool input: ${tool.name || 'Unnamed tool'}`,
      body: stringifyForDetail(tool.input ?? tool),
    })
  }

  return [
    {
      id: `assistant-${id}`,
      kind: 'message',
      role: 'assistant',
      speaker: 'Jarvis',
      body:
        text ||
        (toolUses.length > 0
          ? 'Issued tool calls and is waiting for the local execution loop.'
          : 'Assistant response received.'),
      chips: [
        ...(thinkingBlocks.length > 0 ? ['thinking'] : []),
        ...toolUses.map(tool => tool.name || 'tool'),
      ],
      details,
    },
  ]
}

function buildTranscriptEntries(events: AugmentedDesktopEvent[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = []
  for (const event of events) {
    if (event.type === 'message') {
      const message = event.message as Record<string, any>
      const role = message.type || message.message?.role
      if (role === 'user' || message.message?.role === 'user') {
        entries.push(...normalizeUserEntry(event.id, message))
        continue
      }
      if (role === 'assistant' || message.message?.role === 'assistant') {
        entries.push(...normalizeAssistantEntry(event.id, message))
        continue
      }
      if (role === 'result') {
        entries.push({
          id: `result-${event.id}`,
          kind: 'timeline',
          label: 'Result',
          tone:
            message.subtype === 'error_max_turns' ||
            message.subtype === 'error_during_execution'
              ? 'error'
              : 'idle',
          body:
            message.subtype === 'success'
              ? 'Jarvis completed a turn.'
              : message.result || message.subtype || 'A result event was received.',
          chips: message.subtype ? [message.subtype] : [],
          details: [
            {
              title: 'Raw event',
              body: stringifyForDetail(message),
            },
          ],
        })
        continue
      }
      entries.push({
        id: `event-${event.id}`,
        kind: 'timeline',
        label: titleCase(String(role || 'event')),
        tone: 'idle',
        body: summarizeUnknownMessage(message),
        chips: [],
        details: [
          {
            title: 'Raw event',
            body: stringifyForDetail(message),
          },
        ],
      })
      continue
    }

    if (event.type === 'info') {
      entries.push({
        id: `info-${event.id}`,
        kind: 'timeline',
        label: event.label || 'Runtime',
        tone: 'idle',
        body: event.body || '',
        chips: [],
        details: [],
      })
      continue
    }

    if (event.type === 'stderr') {
      entries.push({
        id: `stderr-${event.id}`,
        kind: 'timeline',
        label: 'Runtime',
        tone: 'error',
        body: event.line || '',
        chips: ['stderr'],
        details: [],
      })
      continue
    }

    if (event.type === 'permission') {
      entries.push({
        id: `permission-${event.id}`,
        kind: 'timeline',
        label: 'Permission requested',
        tone: 'warning',
        body:
          event.description ||
          `${event.toolName} is waiting for approval in the safety rail.`,
        chips: [event.toolName],
        details: [
          {
            title: 'Tool input',
            body: stringifyForDetail(event.input),
          },
        ],
      })
    }
  }

  return entries
}

function statusClass(tone: StatusTone | undefined): string {
  if (tone === 'running') {
    return 'is-running'
  }
  if (tone === 'error') {
    return 'is-error'
  }
  if (tone === 'warning') {
    return 'is-warning'
  }
  return ''
}

function viewTitle(view: DesktopView): string {
  if (view === 'autodream') {
    return 'AutoDream'
  }
  if (view === 'memory') {
    return 'Memory'
  }
  if (view === 'integrations') {
    return 'Integrations'
  }
  if (view === 'companion') {
    return 'Companion'
  }
  return 'Chat'
}

function buildNotice(error: unknown): ConfigNotice {
  return {
    tone: 'error',
    message: error instanceof Error ? error.message : String(error),
  }
}

export function App(): React.ReactNode {
  const [config, setConfig] = useState<LauncherConfig>(DEFAULT_CONFIG)
  const [shell, setShell] = useState<DesktopShellPayload>(DEFAULT_SHELL)
  const [features, setFeatures] = useState<DesktopFeatureSnapshot | null>(null)
  const [models, setModels] = useState<ModelCatalogResponse | null>(null)
  const [runtime, setRuntime] = useState<DesktopRuntimeState>(IDLE_RUNTIME)
  const [events, setEvents] = useState<AugmentedDesktopEvent[]>([])
  const [pendingPermissions, setPendingPermissions] = useState<PendingPermission[]>([])
  const [prompt, setPrompt] = useState('')
  const [loading, setLoading] = useState(true)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [remoteHealth, setRemoteHealth] = useState<RemoteBridgeHealth | null>(null)
  const [notice, setNotice] = useState<ConfigNotice | null>(null)
  const [backendState, setBackendState] = useState<{
    ready: boolean
    url: string | null
    error?: string
  }>({ ready: false, url: null })
  const [integrationSearch, setIntegrationSearch] = useState('')
  const [integrationStatusFilter, setIntegrationStatusFilter] = useState<
    'all' | 'draft' | 'ready' | 'paused'
  >('all')
  const [integrationForm, setIntegrationForm] = useState({
    id: '',
    name: '',
    category: '',
    baseUrl: '',
    authMode: 'none',
    status: 'draft',
    tags: '',
    notes: '',
  })
  const [buddyEditor, setBuddyEditor] =
    useState<DesktopBuddyProfileDraft>(DEFAULT_BUDDY_DRAFT)
  const [selectedBuddyId, setSelectedBuddyId] = useState<string | null>(null)
  const transcriptScrollRef = useRef<HTMLDivElement | null>(null)
  const transcriptBottomRef = useRef<HTMLDivElement | null>(null)
  const nextEventId = useRef(1)
  const reattachPendingRef = useRef(true)
  const observerSuppressedRef = useRef(false)
  const [transcriptAttached, setTranscriptAttached] = useState(true)
  const [transcriptHasUnseenBelow, setTranscriptHasUnseenBelow] = useState(false)

  // Thunder Compute state
  const [thunderPhase, setThunderPhase] = useState<
    'idle' | 'terminal' | 'automating' | 'complete'
  >('idle')
  const [thunderInstanceId, setThunderInstanceId] = useState('')
  const [thunderResumeAvailable, setThunderResumeAvailable] = useState(false)

  const transcriptEntries = useMemo(() => buildTranscriptEntries(events), [events])
  const activeView = shell.uiState.activeView
  const activeBuddy = features?.buddy ?? null

  useEffect(() => {
    let cancelled = false
    window.jarvis
      .bootstrap()
      .then(async (payload: JarvisBootstrapPayload) => {
        if (cancelled) {
          return
        }
        setConfig(payload.config)
        setShell(payload.shell)
        setFeatures(payload.features)
        setModels(payload.models)
        setLoading(false)

        // Check for resumable Thunder session
        if (
          payload.config.thunderSessionActive &&
          payload.config.thunderInstanceId
        ) {
          try {
            const check = await window.jarvis.thunderCheckSession(
              payload.config.thunderInstanceId,
            )
            if (!cancelled && check.running) {
              setThunderResumeAvailable(true)
            } else if (!cancelled) {
              // Instance no longer running — clear session fields
              const cleared: LauncherConfig = {
                ...payload.config,
                thunderInstanceId: '',
                thunderPublicUrl: '',
                thunderSessionActive: false,
              }
              setConfig(cleared)
              void window.jarvis.saveConfig(cleared)
            }
          } catch {
            // tnr not available or failed — ignore
          }
        }
      })
      .catch(error => {
        if (!cancelled) {
          setNotice(buildNotice(error))
          setLoading(false)
        }
      })

    const disposeEvents = window.jarvis.onEvent(payload => {
      startTransition(() => {
        if ((payload as SnapshotEvent).type === 'snapshot') {
          const snapshot = payload as SnapshotEvent
          setRuntime(snapshot.state)
          setPendingPermissions(snapshot.pendingPermissions)
          nextEventId.current = 1
          setEvents(
            snapshot.events.slice(-MAX_TRANSCRIPT_EVENTS).map(event => ({
              ...event,
              id: nextEventId.current++,
            })),
          )
          reattachPendingRef.current = true
          return
        }

        const event = payload as DesktopEvent
        if (event.type === 'state') {
          setRuntime(event.state)
          return
        }
        if (event.type === 'permission') {
          setPendingPermissions(current => {
            const rest = current.filter(item => item.requestId !== event.requestId)
            return [...rest, event]
          })
        }
        if (event.type === 'permission_resolved') {
          setPendingPermissions(current =>
            current.filter(item => item.requestId !== event.requestId),
          )
        }
        setEvents(current => {
          const next = [...current, { ...event, id: nextEventId.current++ }]
          return next.slice(-MAX_TRANSCRIPT_EVENTS)
        })
      })
    })

    const disposeBackend = window.jarvis.onBackendState(payload => {
      setBackendState(payload)
    })

    // Thunder: listen for session detection from Phase 1
    const disposeThunder = window.jarvis.onThunderSessionDetected(payload => {
      setThunderInstanceId(payload.instanceId)
      setThunderPhase('automating')
    })

    return () => {
      cancelled = true
      disposeEvents()
      disposeBackend()
      disposeThunder()
    }
  }, [])

  useEffect(() => {
    if (!features?.buddy) {
      return
    }
    const activeProfile =
      features.buddy.profiles.find(profile => profile.isActive) ??
      features.buddy.profiles[0] ??
      null
    if (!activeProfile) {
      setSelectedBuddyId(null)
      setBuddyEditor(DEFAULT_BUDDY_DRAFT)
      return
    }
    if (!selectedBuddyId || !features.buddy.profiles.some(p => p.id === selectedBuddyId)) {
      setSelectedBuddyId(activeProfile.id)
      setBuddyEditor({
        name: activeProfile.name,
        personality: activeProfile.personality,
        species: activeProfile.species,
        eye: activeProfile.eye,
        hat: activeProfile.hat,
        shiny: activeProfile.shiny,
        rarity: activeProfile.rarity,
      })
    }
  }, [features, selectedBuddyId])

  useEffect(() => {
    setSettingsOpen(shell.uiState.advancedSettingsOpen)
  }, [shell.uiState.advancedSettingsOpen])

  useLayoutEffect(() => {
    const scrollElement = transcriptScrollRef.current
    const bottomElement = transcriptBottomRef.current
    if (!scrollElement || !bottomElement) {
      return
    }
    if (transcriptAttached || reattachPendingRef.current) {
      observerSuppressedRef.current = true
      bottomElement.scrollIntoView({ block: 'end' })
      setTranscriptAttached(true)
      setTranscriptHasUnseenBelow(false)
      reattachPendingRef.current = false
      requestAnimationFrame(() => {
        observerSuppressedRef.current = false
      })
    } else if (transcriptEntries.length > 0) {
      setTranscriptHasUnseenBelow(true)
    }
  }, [transcriptEntries, transcriptAttached])

  useEffect(() => {
    const root = transcriptScrollRef.current
    const bottom = transcriptBottomRef.current
    if (!root || !bottom) {
      return
    }

    const observer = new IntersectionObserver(
      entries => {
        const entry = entries[0]
        if (!entry || observerSuppressedRef.current) {
          return
        }
        if (entry.isIntersecting) {
          setTranscriptAttached(true)
          setTranscriptHasUnseenBelow(false)
        } else {
          setTranscriptAttached(false)
        }
      },
      {
        root,
        threshold: 0.99,
      },
    )

    observer.observe(bottom)
    return () => observer.disconnect()
  }, [])

  const filteredIntegrations = shell.integrations.filter(entry => {
    if (
      integrationStatusFilter !== 'all' &&
      entry.status !== integrationStatusFilter
    ) {
      return false
    }
    if (!integrationSearch.trim()) {
      return true
    }
    const query = integrationSearch.trim().toLowerCase()
    return (
      entry.name.toLowerCase().includes(query) ||
      entry.category.toLowerCase().includes(query) ||
      entry.baseUrl.toLowerCase().includes(query) ||
      entry.notes.toLowerCase().includes(query) ||
      entry.tags.some(tag => tag.toLowerCase().includes(query))
    )
  })

  async function persistShell(nextShell: DesktopShellPayload): Promise<void> {
    const saved = await window.jarvis.saveShell(nextShell)
    setShell(saved)
  }

  async function applyCompanionPayload(
    promise: Promise<JarvisCompanionPayload>,
  ): Promise<void> {
    const payload = await promise
    setFeatures(payload.features)
    setNotice({
      tone: 'idle',
      message: payload.buddy.hatched
        ? `${payload.buddy.name} is active in the companion lane.`
        : 'Companion Studio updated.',
    })
  }

  async function handleSaveConfig(): Promise<void> {
    try {
      const saved = await window.jarvis.saveConfig(config)
      setConfig(saved)
      setNotice({ tone: 'idle', message: 'Jarvis settings saved.' })
    } catch (error) {
      setNotice(buildNotice(error))
    }
  }

  async function handleStartSession(): Promise<void> {
    try {
      await window.jarvis.startSession(config)
      reattachPendingRef.current = true
      setNotice({ tone: 'idle', message: 'Jarvis session launched.' })
      const nextShell = {
        ...shell,
        uiState: { ...shell.uiState, activeView: 'chat' as DesktopView },
      }
      setShell(nextShell)
      void persistShell(nextShell)
    } catch (error) {
      setNotice(buildNotice(error))
    }
  }

  async function handleSendPrompt(): Promise<void> {
    const content = prompt.trim()
    if (!content) {
      return
    }
    try {
      reattachPendingRef.current = true
      setPrompt('')
      const response = (await window.jarvis.sendPrompt(content)) as
        | { features?: DesktopFeatureSnapshot }
        | undefined
      if (response?.features) {
        setFeatures(response.features)
      }
    } catch (error) {
      setNotice(buildNotice(error))
    }
  }

  async function handlePermission(
    requestId: string,
    decision: 'allow' | 'deny',
  ): Promise<void> {
    try {
      await window.jarvis.respondToPermission(requestId, decision)
    } catch (error) {
      setNotice(buildNotice(error))
    }
  }

  async function handleCheckRemoteHealth(): Promise<void> {
    try {
      const health = await window.jarvis.checkRemoteHealth(config)
      setRemoteHealth(health)
      setNotice({
        tone: health.ok && health.ready ? 'idle' : 'warning',
        message: health.message,
      })
    } catch (error) {
      setNotice(buildNotice(error))
    }
  }

  // --- Thunder Compute handlers ---

  async function handleNewGpuSession(): Promise<void> {
    // Require bridge API key before starting
    if (!config.remoteGlmApiKey) {
      setNotice({
        tone: 'warning',
        message: 'Set your Bridge API key in Settings before launching a GPU session.',
      })
      toggleSettings(true)
      return
    }
    try {
      setThunderPhase('terminal')
      await window.jarvis.thunderOpenTerminal()
    } catch (error) {
      setThunderPhase('idle')
      setNotice(buildNotice(error))
    }
  }

  function handleThunderComplete(publicUrl: string, instanceId: string): void {
    setThunderPhase('complete')
    // Save session config
    const updated: LauncherConfig = {
      ...config,
      remoteGlmBaseUrl: publicUrl,
      remoteGlmModel: 'gpt-oss-auto',
      thunderInstanceId: instanceId,
      thunderPublicUrl: publicUrl,
      thunderSessionActive: true,
      backend: 'remote-glm',
    }
    setConfig(updated)
    void window.jarvis.saveConfig(updated)
    setNotice({
      tone: 'idle',
      message: `GPU session active. Instance ${instanceId} connected via ${publicUrl}`,
    })
    // Auto-launch Jarvis session
    void handleStartSession()
    // Reset phase after a moment so the panel clears
    setTimeout(() => setThunderPhase('idle'), 2000)
  }

  function handleThunderAbort(): void {
    setThunderPhase('idle')
    setNotice({
      tone: 'warning',
      message: 'GPU session aborted. The Thunder instance may still be running.',
    })
  }

  async function handleThunderResume(): Promise<void> {
    if (!config.thunderInstanceId || !config.remoteGlmApiKey) {
      return
    }
    setThunderInstanceId(config.thunderInstanceId)
    setThunderPhase('automating')
  }

  async function handleCompanionAction(
    action: 'hatch' | 'rehatch' | 'pet' | 'mute' | 'unmute' | 'reset',
  ): Promise<void> {
    try {
      await applyCompanionPayload(window.jarvis.runCompanionAction(action))
    } catch (error) {
      setNotice(buildNotice(error))
    }
  }

  async function handleCreateBuddy(): Promise<void> {
    try {
      await applyCompanionPayload(window.jarvis.createCompanionProfile(buddyEditor))
    } catch (error) {
      setNotice(buildNotice(error))
    }
  }

  async function handleUpdateBuddy(): Promise<void> {
    if (!selectedBuddyId) {
      await handleCreateBuddy()
      return
    }
    try {
      await applyCompanionPayload(
        window.jarvis.updateCompanionProfile(selectedBuddyId, buddyEditor),
      )
    } catch (error) {
      setNotice(buildNotice(error))
    }
  }

  async function handleSelectBuddy(profile: DesktopBuddyProfile): Promise<void> {
    setSelectedBuddyId(profile.id)
    setBuddyEditor({
      name: profile.name,
      personality: profile.personality,
      species: profile.species,
      eye: profile.eye,
      hat: profile.hat,
      shiny: profile.shiny,
      rarity: profile.rarity,
    })
    try {
      await applyCompanionPayload(window.jarvis.selectCompanionProfile(profile.id))
    } catch (error) {
      setNotice(buildNotice(error))
    }
  }

  async function handleDeleteBuddy(): Promise<void> {
    if (!selectedBuddyId) {
      return
    }
    try {
      await applyCompanionPayload(window.jarvis.deleteCompanionProfile(selectedBuddyId))
      setSelectedBuddyId(null)
      setBuddyEditor(DEFAULT_BUDDY_DRAFT)
    } catch (error) {
      setNotice(buildNotice(error))
    }
  }

  async function handleClearTranscript(): Promise<void> {
    try {
      await window.jarvis.clearTranscript()
      setEvents([])
      setTranscriptHasUnseenBelow(false)
      setTranscriptAttached(true)
    } catch (error) {
      setNotice(buildNotice(error))
    }
  }

  function reattachTranscript(): void {
    reattachPendingRef.current = true
    setTranscriptAttached(true)
    setTranscriptHasUnseenBelow(false)
    transcriptBottomRef.current?.scrollIntoView({ block: 'end' })
  }

  function openView(view: DesktopView): void {
    const nextShell = {
      ...shell,
      uiState: {
        ...shell.uiState,
        activeView: view,
      },
    }
    setShell(nextShell)
    void persistShell(nextShell)
  }

  function toggleSettings(nextOpen?: boolean): void {
    const open = nextOpen ?? !settingsOpen
    setSettingsOpen(open)
    const nextShell = {
      ...shell,
      uiState: {
        ...shell.uiState,
        advancedSettingsOpen: open,
      },
    }
    setShell(nextShell)
    void persistShell(nextShell)
  }

  function loadIntegrationForm(id: string | null): void {
    const entry = shell.integrations.find(item => item.id === id)
    if (!entry) {
      setIntegrationForm({
        id: '',
        name: '',
        category: '',
        baseUrl: '',
        authMode: 'none',
        status: 'draft',
        tags: '',
        notes: '',
      })
      return
    }
    setIntegrationForm({
      id: entry.id,
      name: entry.name,
      category: entry.category,
      baseUrl: entry.baseUrl,
      authMode: entry.authMode,
      status: entry.status,
      tags: entry.tags.join(', '),
      notes: entry.notes,
    })
  }

  async function saveIntegration(): Promise<void> {
    const now = new Date().toISOString()
    const id = integrationForm.id || crypto.randomUUID()
    const nextEntry = {
      id,
      name: integrationForm.name.trim(),
      category: integrationForm.category.trim() || 'General',
      baseUrl: integrationForm.baseUrl.trim(),
      authMode: integrationForm.authMode as any,
      status: integrationForm.status as any,
      notes: integrationForm.notes.trim(),
      tags: integrationForm.tags
        .split(',')
        .map(tag => tag.trim())
        .filter(Boolean),
      updatedAt: now,
    }
    if (!nextEntry.name) {
      setNotice({ tone: 'warning', message: 'Integrations need a name.' })
      return
    }
    const nextIntegrations = shell.integrations
      .filter(entry => entry.id !== id)
      .concat(nextEntry)
      .sort((left, right) => left.name.localeCompare(right.name))
    const nextShell = {
      ...shell,
      integrations: nextIntegrations,
      uiState: {
        ...shell.uiState,
        selectedIntegrationId: id,
      },
    }
    await persistShell(nextShell)
    loadIntegrationForm(id)
    setNotice({ tone: 'idle', message: 'Integration saved.' })
  }

  async function deleteIntegration(): Promise<void> {
    if (!integrationForm.id) {
      return
    }
    const nextShell = {
      ...shell,
      integrations: shell.integrations.filter(entry => entry.id !== integrationForm.id),
      uiState: {
        ...shell.uiState,
        selectedIntegrationId: null,
      },
    }
    await persistShell(nextShell)
    loadIntegrationForm(null)
  }

  useEffect(() => {
    loadIntegrationForm(shell.uiState.selectedIntegrationId)
  }, [shell.uiState.selectedIntegrationId, shell.integrations])

  const chatModeLabel =
    config.backend === 'remote-glm'
      ? `Remote / ${laneLabel(config.remoteGlmModel)}`
      : config.backend === 'ollama'
        ? `Local / ${config.ollamaModel || 'Ollama'}`
        : `Anthropic / ${config.anthropicModel || 'Claude'}`

  return (
    <div className="jarvis-root">
      <header className="titlebar">
        <div className="titlebar-drag">
          <div className="brand-mark">J</div>
          <div className="titlebar-copy">
            <div className="titlebar-title">Jarvis</div>
            <div className="titlebar-subtitle">
              Command-center coding agent / {chatModeLabel}
            </div>
          </div>
        </div>
        <div className="titlebar-status">
          <span className={`status-pill ${statusClass(runtime.tone)}`}>
            {runtime.label}
          </span>
          <button className="window-button" onClick={() => void window.jarvis.minimizeWindow()}>
            _
          </button>
          <button className="window-button" onClick={() => void window.jarvis.maximizeWindow()}>
            []
          </button>
          <button
            className="window-button danger"
            onClick={() => void window.jarvis.closeWindow()}
          >
            X
          </button>
        </div>
      </header>

      <div className="shell-grid">
        <aside className="nav-rail">
          <div className="nav-stack">
            {NAV_ITEMS.map(item => (
              <button
                key={item.id}
                className={`nav-button ${activeView === item.id ? 'active' : ''}`}
                onClick={() => openView(item.id)}
                title={item.label}
              >
                <span className="nav-glyph">{item.glyph}</span>
                <span className="nav-text">{item.label}</span>
              </button>
            ))}
          </div>
          <div className="nav-footer">
            <button className="nav-button ghost" onClick={() => toggleSettings()}>
              <span className="nav-glyph">ST</span>
              <span className="nav-text">Settings</span>
            </button>
          </div>
        </aside>

        <main className="workspace-shell">
          <section className={`hero-strip ${activeView === 'chat' ? 'is-chat' : ''}`}>
            <div className="hero-copy">
              <div className="eyebrow">Jarvis Runtime</div>
              <h1>{viewTitle(activeView)}</h1>
              <p>
                Native desktop shell, Claude-grounded companion behavior, and a
                cleaner command-center interface for GPT-OSS orchestration.
              </p>
            </div>
            <div className="hero-chips">
              <div className="hero-chip">
                <span>Worker</span>
                <strong>{backendState.ready ? 'Ready' : 'Booting'}</strong>
              </div>
              <div className="hero-chip">
                <span>Lane</span>
                <strong>{laneLabel(config.remoteGlmModel)}</strong>
              </div>
              <div className="hero-chip">
                <span>Fallback</span>
                <strong>{models?.defaultModel || 'Loading'}</strong>
              </div>
            </div>
          </section>

          <div className={`workspace-grid ${activeView === 'chat' ? 'chat-active' : ''}`}>
            <section className="content-column">
              {activeView === 'chat' && thunderPhase === 'automating' && (
                <div style={{ flex: 1, padding: 16 }}>
                  <ThunderAutomationPanel
                    instanceId={thunderInstanceId}
                    bridgeApiKey={config.remoteGlmApiKey}
                    onComplete={handleThunderComplete}
                    onAbort={handleThunderAbort}
                  />
                </div>
              )}

              {activeView === 'chat' && thunderPhase !== 'automating' && (
                <div className="chat-shell">
                  {thunderResumeAvailable && thunderPhase === 'idle' && (
                    <div style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      padding: '10px 16px',
                      background: 'var(--accent-soft)',
                      borderRadius: 'var(--radius-sm)',
                      marginBottom: 8,
                      fontSize: 13,
                    }}>
                      <span style={{ color: 'var(--accent-strong)', fontWeight: 600 }}>
                        Active Thunder session: {config.thunderInstanceId}
                      </span>
                      <button
                        className="ghost-button"
                        style={{ marginLeft: 'auto', fontSize: 12 }}
                        onClick={() => void handleThunderResume()}
                      >
                        Resume session
                      </button>
                    </div>
                  )}
                  <div className="command-strip">
                    <div className="command-strip-left">
                      <span className="signal-dot" />
                      <span>{runtime.label}</span>
                      <span className="command-chip">{chatModeLabel}</span>
                      {remoteHealth && (
                        <span
                          className={`command-chip ${remoteHealth.ok && remoteHealth.ready ? 'ok' : 'warn'}`}
                        >
                          {remoteHealth.message}
                        </span>
                      )}
                    </div>
                    <div className="command-strip-actions">
                      <button className="ghost-button" onClick={() => void handleNewGpuSession()}>
                        New GPU Session
                      </button>
                      <button className="ghost-button" onClick={() => void handleCheckRemoteHealth()}>
                        Check server
                      </button>
                      <button className="ghost-button" onClick={() => void handleClearTranscript()}>
                        Clear feed
                      </button>
                      <button className="primary-button" onClick={() => void handleStartSession()}>
                        Launch
                      </button>
                    </div>
                  </div>

                  <div className="transcript-panel">
                    <div className="transcript-scroll" ref={transcriptScrollRef}>
                      <div className="transcript-list">
                        {loading && <div className="empty-state">Booting Jarvis...</div>}
                        {!loading && transcriptEntries.length === 0 && (
                          <div className="empty-state">
                            Launch Jarvis against your GPT-OSS server to begin a session.
                          </div>
                        )}
                        {transcriptEntries.map(entry => (
                          <article
                            key={entry.id}
                            className={`transcript-card ${entry.kind} ${entry.role ?? ''} ${statusClass(entry.tone)}`}
                          >
                            <div className="transcript-head">
                              <strong>{entry.speaker || entry.label || 'Jarvis'}</strong>
                              {entry.label && entry.speaker ? <span>{entry.label}</span> : null}
                            </div>
                            {entry.chips.length > 0 && (
                              <div className="transcript-badges">
                                {entry.chips.map(chip => (
                                  <span key={`${entry.id}-${chip}`} className="command-chip subtle">
                                    {chip}
                                  </span>
                                ))}
                              </div>
                            )}
                            <div className="transcript-body">{entry.body}</div>
                            {entry.details.length > 0 && (
                              <div className="transcript-details">
                                {entry.details.map(detail => (
                                  <details key={`${entry.id}-${detail.title}`}>
                                    <summary>{detail.title}</summary>
                                    <pre>{detail.body}</pre>
                                  </details>
                                ))}
                              </div>
                            )}
                          </article>
                        ))}
                        <div ref={transcriptBottomRef} className="transcript-bottom-sentinel" />
                      </div>
                    </div>

                    {transcriptHasUnseenBelow && !transcriptAttached && (
                      <button className="jump-latest" onClick={reattachTranscript}>
                        Jump to latest
                      </button>
                    )}
                  </div>

                  <div className={`composer-band ${!transcriptAttached ? 'detached' : ''}`}>
                    <div className="composer-panel">
                      <div className="composer-header">
                        <div>
                          <div className="eyebrow">Prompt rail</div>
                          <div className="composer-caption">
                            Pinned live edge with CSS anchoring, stable message rows, and a
                            reserved companion lane.
                          </div>
                        </div>
                        <span className={`command-chip ${statusClass(runtime.tone)}`}>
                          {runtime.busy ? 'Busy' : 'Ready'}
                        </span>
                      </div>
                      <textarea
                        value={prompt}
                        onChange={event => setPrompt(event.target.value)}
                        onKeyDown={event => {
                          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                            event.preventDefault()
                            void handleSendPrompt()
                          }
                        }}
                        placeholder="Send a prompt into the active Jarvis session. Ctrl/Cmd+Enter sends."
                      />
                      <div className="composer-actions">
                        <button className="primary-button" onClick={() => void handleSendPrompt()}>
                          Send
                        </button>
                        <button
                          className="ghost-button"
                          onClick={() =>
                            void window.jarvis.interruptSession().catch(error => {
                              setNotice(buildNotice(error))
                            })
                          }
                        >
                          Interrupt
                        </button>
                        <button
                          className="ghost-button danger"
                          onClick={() =>
                            void window.jarvis.stopSession().catch(error => {
                              setNotice(buildNotice(error))
                            })
                          }
                        >
                          Stop
                        </button>
                      </div>
                    </div>

                    <aside className={`companion-lane ${!transcriptAttached ? 'compact' : ''}`}>
                      <div className={`companion-bubble ${!activeBuddy?.reaction || activeBuddy.muted ? 'hidden' : ''}`}>
                        {activeBuddy?.reaction}
                      </div>
                      <div className="companion-card">
                        <div className="companion-card-top">
                          <div>
                            <div className="eyebrow">Companion</div>
                            <div className="companion-name">
                              {activeBuddy?.hatched ? activeBuddy.name : 'No active buddy'}
                            </div>
                            <div className="companion-meta">
                              {activeBuddy
                                ? `${titleCase(activeBuddy.rarity)} ${activeBuddy.species}`
                                : 'Dormant'}
                            </div>
                          </div>
                          <pre className="companion-face">{activeBuddy?.face}</pre>
                        </div>
                        <pre className="companion-sprite">
                          {activeBuddy?.sprite.join('\n')}
                        </pre>
                        <div className="companion-line">
                          {activeBuddy?.hatched
                            ? activeBuddy.personality
                            : 'Create or hatch a buddy, then keep it docked beside the prompt rail.'}
                        </div>
                        <div className="companion-actions">
                          {!activeBuddy?.hatched ? (
                            <button
                              className="primary-button"
                              onClick={() => void handleCompanionAction('hatch')}
                            >
                              Hatch buddy
                            </button>
                          ) : (
                            <>
                              <button
                                className="primary-button"
                                onClick={() => void handleCompanionAction('pet')}
                              >
                                Pet
                              </button>
                              <button
                                className="ghost-button"
                                onClick={() =>
                                  void handleCompanionAction(
                                    activeBuddy.muted ? 'unmute' : 'mute',
                                  )
                                }
                              >
                                {activeBuddy.muted ? 'Unmute' : 'Mute'}
                              </button>
                            </>
                          )}
                          <button className="ghost-button" onClick={() => openView('companion')}>
                            Studio
                          </button>
                        </div>
                      </div>
                    </aside>
                  </div>
                </div>
              )}

              {activeView === 'autodream' && features && (
                <section className="feature-grid">
                  <div className="feature-card span-6">
                    <div className="eyebrow">Cadence</div>
                    <h2>{features.autoDream.ready ? 'Ready to consolidate' : 'Waiting on gates'}</h2>
                    <p>{features.autoDream.lockStatus}</p>
                  </div>
                  <div className="feature-card span-3">
                    <div className="eyebrow">Session gate</div>
                    <h2>{features.autoDream.sessionsSinceLast}</h2>
                    <p>Target: {features.autoDream.minSessions} sessions</p>
                  </div>
                  <div className="feature-card span-3">
                    <div className="eyebrow">Time gate</div>
                    <h2>{features.autoDream.minHours}h</h2>
                    <p>
                      {features.autoDream.lastConsolidatedAt
                        ? `Last pass ${formatDateTime(features.autoDream.lastConsolidatedAt)}`
                        : 'No prior pass recorded'}
                    </p>
                  </div>
                  <div className="feature-card span-12">
                    <div className="eyebrow">Dream phases</div>
                    <div className="phase-row">
                      {features.autoDream.phases.map(phase => (
                        <span key={phase} className="phase-pill">
                          {phase}
                        </span>
                      ))}
                    </div>
                  </div>
                </section>
              )}

              {activeView === 'memory' && features && (
                <section className="feature-grid">
                  <div className="feature-card span-4">
                    <div className="eyebrow">Entrypoint</div>
                    <h2>MEMORY.md</h2>
                    <p>{features.memory.entrypointPath}</p>
                  </div>
                  <div className="feature-card span-4">
                    <div className="eyebrow">Indexed lines</div>
                    <h2>{features.memory.lineCount}</h2>
                    <p>Preview limit {features.memory.maxLines} lines</p>
                  </div>
                  <div className="feature-card span-4">
                    <div className="eyebrow">Status</div>
                    <h2>{features.memory.enabled ? 'Enabled' : 'Disabled'}</h2>
                    <p>Skeptical memory discipline is still enforced.</p>
                  </div>
                  <div className="feature-card span-8">
                    <div className="eyebrow">Preview</div>
                    <pre className="memory-preview">
                      {features.memory.preview.join('\n')}
                    </pre>
                  </div>
                  <div className="feature-card span-4">
                    <div className="eyebrow">Rules</div>
                    <ul className="bullet-list">
                      {features.memory.rules.map(rule => (
                        <li key={rule}>{rule}</li>
                      ))}
                    </ul>
                  </div>
                </section>
              )}

              {activeView === 'integrations' && (
                <section className="integration-shell">
                  <div className="integration-toolbar">
                    <input
                      value={integrationSearch}
                      onChange={event => setIntegrationSearch(event.target.value)}
                      placeholder="Search integrations"
                    />
                    <div className="segmented-control">
                      {(['all', 'ready', 'draft', 'paused'] as const).map(filter => (
                        <button
                          key={filter}
                          className={integrationStatusFilter === filter ? 'active' : ''}
                          onClick={() => setIntegrationStatusFilter(filter)}
                        >
                          {titleCase(filter)}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="integration-grid">
                    <div className="feature-card">
                      <div className="eyebrow">Registry</div>
                      <div className="integration-list">
                        {filteredIntegrations.map(entry => (
                          <button
                            key={entry.id}
                            className={`integration-row ${shell.uiState.selectedIntegrationId === entry.id ? 'active' : ''}`}
                            onClick={() => {
                              const nextShell = {
                                ...shell,
                                uiState: {
                                  ...shell.uiState,
                                  selectedIntegrationId: entry.id,
                                },
                              }
                              setShell(nextShell)
                              void persistShell(nextShell)
                            }}
                          >
                            <strong>{entry.name}</strong>
                            <span>{entry.category}</span>
                            <span>{entry.status}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="feature-card">
                      <div className="eyebrow">Editor</div>
                      <div className="form-grid">
                        <label>
                          Name
                          <input
                            value={integrationForm.name}
                            onChange={event =>
                              setIntegrationForm(current => ({
                                ...current,
                                name: event.target.value,
                              }))
                            }
                          />
                        </label>
                        <label>
                          Category
                          <input
                            value={integrationForm.category}
                            onChange={event =>
                              setIntegrationForm(current => ({
                                ...current,
                                category: event.target.value,
                              }))
                            }
                          />
                        </label>
                        <label className="span-2">
                          Base URL
                          <input
                            value={integrationForm.baseUrl}
                            onChange={event =>
                              setIntegrationForm(current => ({
                                ...current,
                                baseUrl: event.target.value,
                              }))
                            }
                          />
                        </label>
                        <label>
                          Auth
                          <select
                            value={integrationForm.authMode}
                            onChange={event =>
                              setIntegrationForm(current => ({
                                ...current,
                                authMode: event.target.value,
                              }))
                            }
                          >
                            <option value="none">None</option>
                            <option value="bearer">Bearer</option>
                            <option value="api-key">API key</option>
                            <option value="basic">Basic</option>
                          </select>
                        </label>
                        <label>
                          Status
                          <select
                            value={integrationForm.status}
                            onChange={event =>
                              setIntegrationForm(current => ({
                                ...current,
                                status: event.target.value,
                              }))
                            }
                          >
                            <option value="draft">Draft</option>
                            <option value="ready">Ready</option>
                            <option value="paused">Paused</option>
                          </select>
                        </label>
                        <label className="span-2">
                          Tags
                          <input
                            value={integrationForm.tags}
                            onChange={event =>
                              setIntegrationForm(current => ({
                                ...current,
                                tags: event.target.value,
                              }))
                            }
                          />
                        </label>
                        <label className="span-2">
                          Notes
                          <textarea
                            value={integrationForm.notes}
                            onChange={event =>
                              setIntegrationForm(current => ({
                                ...current,
                                notes: event.target.value,
                              }))
                            }
                          />
                        </label>
                      </div>
                      <div className="panel-actions">
                        <button className="primary-button" onClick={() => void saveIntegration()}>
                          Save integration
                        </button>
                        <button
                          className="ghost-button"
                          onClick={() => {
                            const nextShell = {
                              ...shell,
                              uiState: {
                                ...shell.uiState,
                                selectedIntegrationId: null,
                              },
                            }
                            setShell(nextShell)
                            void persistShell(nextShell)
                          }}
                        >
                          New entry
                        </button>
                        <button className="ghost-button danger" onClick={() => void deleteIntegration()}>
                          Delete
                        </button>
                      </div>
                    </div>
                  </div>
                </section>
              )}

              {activeView === 'companion' && features && (
                <section className="companion-studio-grid">
                  <div className="feature-card">
                    <div className="eyebrow">Roster</div>
                    <div className="companion-roster">
                      {features.buddy.profiles.map(profile => (
                        <button
                          key={profile.id}
                          className={`companion-row ${profile.isActive ? 'active' : ''}`}
                          onClick={() => void handleSelectBuddy(profile)}
                        >
                          <div>
                            <strong>{profile.name}</strong>
                            <span>
                              {titleCase(profile.rarity)} {profile.species}
                            </span>
                          </div>
                          <span>{profile.isActive ? 'Active' : 'Select'}</span>
                        </button>
                      ))}
                      {features.buddy.profiles.length === 0 && (
                        <div className="empty-subtle">
                          No saved buddies yet. Hatch one or build a custom profile.
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="feature-card">
                    <div className="eyebrow">Companion studio</div>
                    <div className="studio-grid">
                      <label>
                        Name
                        <input
                          value={buddyEditor.name}
                          onChange={event =>
                            setBuddyEditor(current => ({
                              ...current,
                              name: event.target.value,
                            }))
                          }
                        />
                      </label>
                      <label>
                        Rarity
                        <select
                          value={buddyEditor.rarity}
                          onChange={event =>
                            setBuddyEditor(current => ({
                              ...current,
                              rarity: event.target.value as DesktopBuddyProfileDraft['rarity'],
                            }))
                          }
                        >
                          <option value="common">Common</option>
                          <option value="uncommon">Uncommon</option>
                          <option value="rare">Rare</option>
                          <option value="epic">Epic</option>
                          <option value="legendary">Legendary</option>
                        </select>
                      </label>
                      <label>
                        Species
                        <input
                          value={buddyEditor.species}
                          onChange={event =>
                            setBuddyEditor(current => ({
                              ...current,
                              species: event.target.value,
                            }))
                          }
                        />
                      </label>
                      <label>
                        Eye
                        <input
                          value={buddyEditor.eye}
                          onChange={event =>
                            setBuddyEditor(current => ({
                              ...current,
                              eye: event.target.value,
                            }))
                          }
                        />
                      </label>
                      <label>
                        Hat
                        <input
                          value={buddyEditor.hat}
                          onChange={event =>
                            setBuddyEditor(current => ({
                              ...current,
                              hat: event.target.value,
                            }))
                          }
                        />
                      </label>
                      <label className="toggle-field">
                        <input
                          type="checkbox"
                          checked={buddyEditor.shiny}
                          onChange={event =>
                            setBuddyEditor(current => ({
                              ...current,
                              shiny: event.target.checked,
                            }))
                          }
                        />
                        <span>Shiny variant</span>
                      </label>
                      <label className="span-2">
                        Personality
                        <textarea
                          value={buddyEditor.personality}
                          onChange={event =>
                            setBuddyEditor(current => ({
                              ...current,
                              personality: event.target.value,
                            }))
                          }
                        />
                      </label>
                    </div>
                    <div className="panel-actions">
                      <button className="primary-button" onClick={() => void handleCreateBuddy()}>
                        Create buddy
                      </button>
                      <button className="ghost-button" onClick={() => void handleUpdateBuddy()}>
                        Update selected
                      </button>
                      <button className="ghost-button" onClick={() => void handleDeleteBuddy()}>
                        Delete selected
                      </button>
                    </div>
                    <div className="companion-notes">
                      <p>
                        Jarvis now lets you elect your active buddy at will. Claude's sprite
                        system and prompt semantics still power the dock, bubble, and model
                        separation rules.
                      </p>
                      <p>
                        The active buddy appears beside the prompt rail, can be switched at
                        any time, and stays available through <code>/buddy</code>.
                      </p>
                    </div>
                  </div>
                </section>
              )}
            </section>

            <aside className="context-rail">
              <div className="rail-card">
                <div className="eyebrow">Runtime</div>
                <h3>{runtime.running ? 'Session live' : 'Ready state'}</h3>
                <p>{runtime.label}</p>
                <div className="rail-list">
                  <div>
                    <span>Backend</span>
                    <strong>{config.backend}</strong>
                  </div>
                  <div>
                    <span>Model</span>
                    <strong>{runtime.model || config.remoteGlmModel || 'Unassigned'}</strong>
                  </div>
                  <div>
                    <span>Worker URL</span>
                    <strong>{backendState.url || 'Starting'}</strong>
                  </div>
                </div>
              </div>

              <div className="rail-card">
                <div className="eyebrow">Permissions</div>
                <h3>{pendingPermissions.length} waiting</h3>
                <div className="permission-list">
                  {pendingPermissions.length === 0 && (
                    <div className="empty-subtle">No tools are waiting for a decision.</div>
                  )}
                  {pendingPermissions.map(permission => (
                    <div key={permission.requestId} className="permission-card">
                      <div>
                        <strong>{permission.toolName}</strong>
                        <p>{permission.description || 'Awaiting your decision.'}</p>
                      </div>
                      <div className="inline-buttons">
                        <button
                          className="primary-button"
                          onClick={() => void handlePermission(permission.requestId, 'allow')}
                        >
                          Allow
                        </button>
                        <button
                          className="ghost-button danger"
                          onClick={() => void handlePermission(permission.requestId, 'deny')}
                        >
                          Deny
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {features && (
                <>
                  <div className="rail-card">
                    <div className="eyebrow">AutoDream</div>
                    <h3>{features.autoDream.ready ? 'Ready' : 'Waiting'}</h3>
                    <p>{features.autoDream.lockStatus}</p>
                  </div>
                  <div className="rail-card">
                    <div className="eyebrow">Memory</div>
                    <h3>{features.memory.lineCount} indexed lines</h3>
                    <p>{features.memory.entrypointPath}</p>
                  </div>
                </>
              )}
            </aside>
          </div>
        </main>
      </div>

      <aside className={`settings-drawer ${settingsOpen ? 'open' : ''}`}>
        <div className="settings-header">
          <div>
            <div className="eyebrow">Connection controls</div>
            <h2>Jarvis settings</h2>
          </div>
          <button className="ghost-button" onClick={() => toggleSettings(false)}>
            Close
          </button>
        </div>
        <div className="settings-body">
          <div className="segmented-control">
            <button
              className={config.backend === 'remote-glm' ? 'active' : ''}
              onClick={() => setConfig(current => ({ ...current, backend: 'remote-glm' }))}
            >
              Remote
            </button>
            <button
              className={config.backend === 'ollama' ? 'active' : ''}
              onClick={() => setConfig(current => ({ ...current, backend: 'ollama' }))}
            >
              Local
            </button>
            <button
              className={config.backend === 'anthropic' ? 'active' : ''}
              onClick={() => setConfig(current => ({ ...current, backend: 'anthropic' }))}
            >
              Anthropic
            </button>
          </div>

          <div className="drawer-form">
            <label>
              Workspace path
              <input
                value={config.workspacePath}
                onChange={event =>
                  setConfig(current => ({ ...current, workspacePath: event.target.value }))
                }
              />
            </label>

            {config.backend === 'remote-glm' && (
              <>
                <label>
                  Bridge URL
                  <input
                    value={config.remoteGlmBaseUrl}
                    onChange={event =>
                      setConfig(current => ({
                        ...current,
                        remoteGlmBaseUrl: event.target.value,
                      }))
                    }
                  />
                </label>
                <label>
                  API key
                  <input
                    type="password"
                    value={config.remoteGlmApiKey}
                    onChange={event =>
                      setConfig(current => ({
                        ...current,
                        remoteGlmApiKey: event.target.value,
                      }))
                    }
                  />
                </label>
                <label>
                  Lane
                  <select
                    value={config.remoteGlmModel}
                    onChange={event =>
                      setConfig(current => ({
                        ...current,
                        remoteGlmModel: event.target.value,
                      }))
                    }
                  >
                    <option value="gpt-oss-auto">Auto</option>
                    <option value="gpt-oss-120b">120B</option>
                    <option value="gpt-oss-20b">20B</option>
                  </select>
                </label>
              </>
            )}

            {config.backend === 'ollama' && (
              <>
                <label>
                  Ollama base URL
                  <input
                    value={config.ollamaBaseUrl}
                    onChange={event =>
                      setConfig(current => ({
                        ...current,
                        ollamaBaseUrl: event.target.value,
                      }))
                    }
                  />
                </label>
                <label>
                  Local model
                  <input
                    value={config.ollamaModel}
                    onChange={event =>
                      setConfig(current => ({
                        ...current,
                        ollamaModel: event.target.value,
                      }))
                    }
                  />
                </label>
              </>
            )}

            {config.backend === 'anthropic' && (
              <>
                <label>
                  Base URL
                  <input
                    value={config.anthropicBaseUrl}
                    onChange={event =>
                      setConfig(current => ({
                        ...current,
                        anthropicBaseUrl: event.target.value,
                      }))
                    }
                  />
                </label>
                <label>
                  API key
                  <input
                    type="password"
                    value={config.anthropicApiKey}
                    onChange={event =>
                      setConfig(current => ({
                        ...current,
                        anthropicApiKey: event.target.value,
                      }))
                    }
                  />
                </label>
                <label>
                  Model
                  <input
                    value={config.anthropicModel}
                    onChange={event =>
                      setConfig(current => ({
                        ...current,
                        anthropicModel: event.target.value,
                      }))
                    }
                  />
                </label>
              </>
            )}

            <label className="toggle-field">
              <input
                type="checkbox"
                checked={config.coordinatorMode}
                onChange={event =>
                  setConfig(current => ({
                    ...current,
                    coordinatorMode: event.target.checked,
                  }))
                }
              />
              <span>Enable coordinator mode</span>
            </label>
            <label className="toggle-field">
              <input
                type="checkbox"
                checked={config.disableThinkingForLocal}
                onChange={event =>
                  setConfig(current => ({
                    ...current,
                    disableThinkingForLocal: event.target.checked,
                  }))
                }
              />
              <span>Disable thinking for local fallback</span>
            </label>
            <label>
              Appended system prompt
              <textarea
                value={config.appendSystemPrompt}
                onChange={event =>
                  setConfig(current => ({
                    ...current,
                    appendSystemPrompt: event.target.value,
                  }))
                }
              />
            </label>
          </div>
        </div>
        <div className="settings-footer">
          <button className="ghost-button" onClick={() => void handleCheckRemoteHealth()}>
            Check server
          </button>
          <button className="primary-button" onClick={() => void handleSaveConfig()}>
            Save settings
          </button>
        </div>
      </aside>

      {notice && (
        <div className={`notice-bar ${statusClass(notice.tone)}`}>
          <span>{notice.message}</span>
          <button onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      )}
    </div>
  )
}
