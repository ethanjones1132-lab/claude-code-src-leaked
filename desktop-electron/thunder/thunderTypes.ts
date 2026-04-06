/** Thunder Compute session orchestrator types */

export type ThunderStepId =
  | 'connect-instance'
  | 'get-ssh-info'
  | 'system-prep'
  | 'start-vllm'
  | 'poll-vllm'
  | 'pull-bridge'
  | 'start-bridge'
  | 'poll-bridge'
  | 'verify-ports'
  | 'forward-port'
  | 'health-check'
  | 'save-config'

export type ThunderStepState = 'pending' | 'active' | 'done' | 'error'

export type ThunderStepStatus = {
  id: ThunderStepId
  label: string
  state: ThunderStepState
  startedAt: number | null
  error: string | null
}

export type ThunderSessionConfig = {
  thunderInstanceId: string
  thunderPublicUrl: string
  thunderSessionActive: boolean
}

export type ThunderSshInfo = {
  host: string
  port: number
  username: string
  privateKeyPath: string
}

export type ThunderLogLine = {
  timestamp: number
  source: ThunderStepId | 'detection' | 'pty'
  text: string
}

export type ThunderSessionDetectedPayload = {
  instanceId: string
}

export type ThunderStepUpdatePayload = {
  stepId: ThunderStepId
  state: ThunderStepState
  error: string | null
}

export type ThunderLogStreamPayload = {
  source: string
  text: string
}

export const THUNDER_STEPS: Array<{ id: ThunderStepId; label: string }> = [
  { id: 'connect-instance', label: 'Connect to instance' },
  { id: 'get-ssh-info', label: 'Get SSH details' },
  { id: 'system-prep', label: 'Install dependencies' },
  { id: 'start-vllm', label: 'Start vLLM server' },
  { id: 'poll-vllm', label: 'Wait for model loading' },
  { id: 'pull-bridge', label: 'Pull bridge code' },
  { id: 'start-bridge', label: 'Start bridge server' },
  { id: 'poll-bridge', label: 'Verify bridge ready' },
  { id: 'verify-ports', label: 'Verify listening ports' },
  { id: 'forward-port', label: 'Forward port 8787' },
  { id: 'health-check', label: 'End-to-end health check' },
  { id: 'save-config', label: 'Save config & connect' },
]

export const THUNDER_ERROR_MESSAGES: Record<string, string> = {
  'connect-failed':
    "Could not connect to instance {id}. Run 'tnr status' to verify it is still running.",
  'ssh-failed':
    'Could not establish SSH connection to the GPU instance. Verify the instance is active and tnr connect completed successfully.',
  'vllm-oom':
    'vLLM ran out of GPU memory loading the 120B model. Check ~/gptoss-120b.log. Try reducing --gpu-memory-utilization to 0.90.',
  'vllm-timeout':
    'vLLM has not become ready after 25 minutes. If this is a fresh instance, the model weights may still be downloading (~70GB). Check ~/gptoss-120b.log for download progress. If a download is in progress, extend the timeout and retry.',
  'bridge-crash':
    'Bridge process failed to start. Check ~/jarvis-bridge.log for Python errors. Verify the git checkout in ~/claude-code-src-leaked is on the codex/remote-glm-bridge branch.',
  'public-url-unreachable':
    'Bridge is running and ports are forwarded, but the public URL is not responding. This is usually a propagation delay. Wait 60 seconds and retry the health check.',
}
