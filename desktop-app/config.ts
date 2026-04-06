import { mkdir, readFile, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import {
  ALTERNATE_OLLAMA_MODEL,
  DEFAULT_OLLAMA_MODEL,
  REMOVED_OLLAMA_MODELS,
} from './modelProfiles.js'

export type BackendType = 'anthropic' | 'ollama' | 'remote-glm'

export type LauncherConfig = {
  workspacePath: string
  backend: BackendType
  anthropicApiKey: string
  anthropicBaseUrl: string
  anthropicModel: string
  ollamaBaseUrl: string
  ollamaModel: string
  remoteGlmBaseUrl: string
  remoteGlmApiKey: string
  remoteGlmModel: string
  coordinatorMode: boolean
  disableToolsForLocal: boolean
  enableExperimentalLocalTools: boolean
  disableNonessentialTraffic: boolean
  disableThinkingForLocal: boolean
  appendSystemPrompt: string
  thunderInstanceId: string
  thunderPublicUrl: string
  thunderSessionActive: boolean
}

function getConfigDir(): string {
  const appData =
    process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
  return join(appData, 'ClaudeBodyDesktop')
}

export function getConfigPath(): string {
  return join(getConfigDir(), 'config.json')
}

export function getDefaultConfig(workspacePath: string): LauncherConfig {
  return {
    workspacePath,
    backend: 'remote-glm',
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
    anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL ?? '',
    anthropicModel: process.env.ANTHROPIC_MODEL ?? 'claude-3-7-sonnet-20250219',
    ollamaBaseUrl: process.env.ANTHROPIC_BASE_URL || 'http://localhost:11434/v1',
    ollamaModel:
      process.env.ANTHROPIC_MODEL &&
      !REMOVED_OLLAMA_MODELS.includes(process.env.ANTHROPIC_MODEL as any)
        ? process.env.ANTHROPIC_MODEL
        : DEFAULT_OLLAMA_MODEL,
    remoteGlmBaseUrl:
      process.env.GPT_OSS_BRIDGE_URL ??
      process.env.REMOTE_OSS_BASE_URL ??
      process.env.REMOTE_GLM_BASE_URL ??
      '',
    remoteGlmApiKey:
      process.env.GPT_OSS_BRIDGE_API_KEY ??
      process.env.REMOTE_OSS_API_KEY ??
      process.env.REMOTE_GLM_API_KEY ??
      '',
    remoteGlmModel:
      process.env.GPT_OSS_MODEL ??
      process.env.REMOTE_OSS_MODEL ??
      process.env.REMOTE_GLM_MODEL ??
      'gpt-oss-auto',
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
}

export async function loadLauncherConfig(
  workspacePath: string,
): Promise<LauncherConfig> {
  const defaults = getDefaultConfig(workspacePath)
  try {
    const raw = await readFile(getConfigPath(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<LauncherConfig>
    return {
      ...defaults,
      ...parsed,
      workspacePath: parsed.workspacePath?.trim() || defaults.workspacePath,
      anthropicApiKey: parsed.anthropicApiKey ?? defaults.anthropicApiKey,
      anthropicBaseUrl: parsed.anthropicBaseUrl ?? defaults.anthropicBaseUrl,
      anthropicModel: parsed.anthropicModel ?? defaults.anthropicModel,
      ollamaBaseUrl: parsed.ollamaBaseUrl ?? defaults.ollamaBaseUrl,
      ollamaModel:
        !parsed.ollamaModel ||
        REMOVED_OLLAMA_MODELS.includes(parsed.ollamaModel as any)
          ? defaults.ollamaModel || ALTERNATE_OLLAMA_MODEL
          : parsed.ollamaModel,
      remoteGlmBaseUrl: parsed.remoteGlmBaseUrl ?? defaults.remoteGlmBaseUrl,
      remoteGlmApiKey: parsed.remoteGlmApiKey ?? defaults.remoteGlmApiKey,
      remoteGlmModel: parsed.remoteGlmModel ?? defaults.remoteGlmModel,
      appendSystemPrompt:
        parsed.appendSystemPrompt ?? defaults.appendSystemPrompt,
      thunderInstanceId: parsed.thunderInstanceId ?? defaults.thunderInstanceId,
      thunderPublicUrl: parsed.thunderPublicUrl ?? defaults.thunderPublicUrl,
      thunderSessionActive:
        parsed.thunderSessionActive ?? defaults.thunderSessionActive,
    }
  } catch {
    return defaults
  }
}

export async function saveLauncherConfig(config: LauncherConfig): Promise<void> {
  await mkdir(getConfigDir(), { recursive: true })
  await writeFile(getConfigPath(), JSON.stringify(config, null, 2), 'utf8')
}
