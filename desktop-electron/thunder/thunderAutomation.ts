/**
 * Thunder Compute — Phase 2 Automation Engine
 *
 * Orchestrates all post-creation steps: tnr connect, SSH setup,
 * remote dependency install, vLLM launch, bridge start, port forwarding,
 * and end-to-end health check.
 */

import { exec, spawn } from 'child_process'
import { readFile } from 'fs/promises'
import { homedir } from 'os'
import path from 'path'
import { Client as SshClient } from 'ssh2'
import type { BrowserWindow } from 'electron'
import type {
  ThunderSshInfo,
  ThunderStepId,
  ThunderStepState,
} from './thunderTypes.js'

type StepEmitter = {
  updateStep(stepId: ThunderStepId, state: ThunderStepState, error: string | null): void
  log(source: string, text: string): void
}

type AutomationContext = {
  instanceId: string
  bridgeApiKey: string
  emitter: StepEmitter
  mainWindow: BrowserWindow
  abortSignal: AbortSignal
}

function execAsync(
  command: string,
  options: { timeout?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    exec(command, { timeout: options.timeout ?? 30_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${error.message}\nstderr: ${stderr}`))
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

function spawnAsync(
  command: string,
  args: string[],
  emitter: StepEmitter,
  source: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', (chunk: Buffer) => {
      emitter.log(source, chunk.toString())
    })
    child.stderr.on('data', (chunk: Buffer) => {
      emitter.log(source, chunk.toString())
    })
    child.on('error', reject)
    child.on('exit', code => resolve(code ?? 1))
  })
}

/**
 * Execute a command on the remote GPU instance via SSH.
 * Streams stdout/stderr to the emitter. Rejects on non-zero exit.
 */
function sshExec(
  client: SshClient,
  command: string,
  emitter: StepEmitter,
  source: string,
  timeoutMs: number = 300_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => {
      reject(new Error(`SSH command timed out after ${timeoutMs / 1000}s: ${command.slice(0, 80)}`))
    }, timeoutMs)

    client.exec(command, (err, stream) => {
      if (err) {
        clearTimeout(timer)
        reject(err)
        return
      }
      stream.on('data', (data: Buffer) => {
        const text = data.toString()
        output += text
        emitter.log(source, text)
      })
      stream.stderr.on('data', (data: Buffer) => {
        const text = data.toString()
        output += text
        emitter.log(source, text)
      })
      stream.on('close', (code: number) => {
        clearTimeout(timer)
        if (code !== 0) {
          reject(
            new Error(
              `Remote command exited with code ${code}: ${command.slice(0, 80)}\n${output.slice(-500)}`,
            ),
          )
          return
        }
        resolve(output)
      })
    })
  })
}

function connectSsh(info: ThunderSshInfo, privateKey: Buffer): Promise<SshClient> {
  return new Promise((resolve, reject) => {
    const client = new SshClient()
    client
      .on('ready', () => resolve(client))
      .on('error', reject)
      .connect({
        host: info.host,
        port: info.port,
        username: info.username,
        privateKey,
      })
  })
}

// ---------------------------------------------------------------------------
// Step implementations
// ---------------------------------------------------------------------------

async function stepConnectInstance(ctx: AutomationContext): Promise<void> {
  ctx.emitter.updateStep('connect-instance', 'active', null)
  try {
    const code = await spawnAsync(
      'tnr',
      ['connect', '0'],
      ctx.emitter,
      'connect-instance',
    )
    if (code !== 0) {
      throw new Error(
        `tnr connect exited with code ${code}. Run 'tnr status' to verify the instance is still running.`,
      )
    }
    ctx.emitter.updateStep('connect-instance', 'done', null)
  } catch (err) {
    const msg =
      err instanceof Error ? err.message : String(err)
    ctx.emitter.updateStep('connect-instance', 'error', msg)
    throw err
  }
}

async function stepGetSshInfo(ctx: AutomationContext): Promise<ThunderSshInfo> {
  ctx.emitter.updateStep('get-ssh-info', 'active', null)
  try {
    const { stdout } = await execAsync('tnr status', { timeout: 15_000 })
    ctx.emitter.log('get-ssh-info', stdout)

    // Parse SSH host from tnr status output
    let host = ''
    let port = 22
    const hostMatch = stdout.match(
      /(?:ssh\s+.*?@)?(\d+\.\d+\.\d+\.\d+|[\w.-]+\.thundercompute\.\w+)/i,
    )
    if (hostMatch) {
      host = hostMatch[1]
    }
    const portMatch = stdout.match(/-p\s+(\d+)/)
    if (portMatch) {
      port = parseInt(portMatch[1], 10)
    }

    // Try to find key path
    let privateKeyPath = ''
    const keyMatch = stdout.match(/-i\s+"?([^"\s]+)"?/)
    if (keyMatch) {
      privateKeyPath = keyMatch[1]
    }

    // Fallback: check common locations
    if (!privateKeyPath) {
      const candidates = [
        path.join(homedir(), '.tnr', 'id_rsa'),
        path.join(homedir(), '.tnr', 'ssh_key'),
        path.join(
          process.env.APPDATA ?? path.join(homedir(), 'AppData', 'Roaming'),
          'tnr',
          'id_rsa',
        ),
        path.join(
          process.env.APPDATA ?? path.join(homedir(), 'AppData', 'Roaming'),
          'tnr',
          'ssh_key',
        ),
      ]
      for (const candidate of candidates) {
        try {
          await readFile(candidate)
          privateKeyPath = candidate
          break
        } catch {
          // Try next
        }
      }
    }

    // If still no host, try `tnr ssh 0 --dry-run` style
    if (!host || !privateKeyPath) {
      try {
        const { stdout: sshOut } = await execAsync('tnr ssh 0 --dry-run', {
          timeout: 10_000,
        })
        ctx.emitter.log('get-ssh-info', sshOut)

        if (!host) {
          const h = sshOut.match(
            /ubuntu@([\w.-]+)/,
          )
          if (h) {
            host = h[1]
          }
        }
        if (!privateKeyPath) {
          const k = sshOut.match(/-i\s+"?([^"\s]+)"?/)
          if (k) {
            privateKeyPath = k[1]
          }
        }
      } catch {
        // Non-fatal: we may already have enough info
      }
    }

    if (!host) {
      throw new Error(
        'Could not determine SSH host from tnr status output. Raw output logged above.',
      )
    }
    if (!privateKeyPath) {
      throw new Error(
        'Could not find SSH private key. Checked ~/.tnr/ and %APPDATA%/tnr/.',
      )
    }

    const info: ThunderSshInfo = {
      host,
      port,
      username: 'ubuntu',
      privateKeyPath,
    }
    ctx.emitter.updateStep('get-ssh-info', 'done', null)
    return info
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    ctx.emitter.updateStep('get-ssh-info', 'error', msg)
    throw err
  }
}

async function stepSystemPrep(
  client: SshClient,
  ctx: AutomationContext,
): Promise<void> {
  ctx.emitter.updateStep('system-prep', 'active', null)
  try {
    const commands = [
      'sudo apt-get update -y',
      'sudo apt-get install -y python3-pip curl git',
      'python3 -m pip install --upgrade pip',
      'python3 -m pip install -U vllm fastapi uvicorn httpx',
    ]
    for (const cmd of commands) {
      await sshExec(client, cmd, ctx.emitter, 'system-prep', 600_000) // 10min for installs
    }
    ctx.emitter.updateStep('system-prep', 'done', null)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    ctx.emitter.updateStep('system-prep', 'error', msg)
    throw err
  }
}

async function stepStartVllm(
  client: SshClient,
  ctx: AutomationContext,
): Promise<string> {
  ctx.emitter.updateStep('start-vllm', 'active', null)
  try {
    const cmd = [
      'export CUDA_VISIBLE_DEVICES=0',
      'export VLLM_TARGET_DEVICE=cuda',
      'export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True',
      'nohup python3 -m vllm.entrypoints.openai.api_server \\',
      '  --model openai/gpt-oss-120b \\',
      '  --host 0.0.0.0 \\',
      '  --port 8000 \\',
      '  --gpu-memory-utilization 0.95 \\',
      '  --max-model-len 2048 \\',
      '  --max-num-seqs 1 \\',
      '  --max-num-batched-tokens 512 \\',
      '  --enforce-eager \\',
      '  --generation-config vllm > ~/gptoss-120b.log 2>&1 &',
      'echo "VLLM_PID=$!"',
    ].join('\n')
    const output = await sshExec(client, cmd, ctx.emitter, 'start-vllm', 30_000)
    const pidMatch = output.match(/VLLM_PID=(\d+)/)
    const pid = pidMatch ? pidMatch[1] : 'unknown'
    ctx.emitter.log('start-vllm', `vLLM started with PID ${pid}`)
    ctx.emitter.updateStep('start-vllm', 'done', null)
    return pid
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    ctx.emitter.updateStep('start-vllm', 'error', msg)
    throw err
  }
}

async function stepPollVllm(
  client: SshClient,
  ctx: AutomationContext,
): Promise<void> {
  ctx.emitter.updateStep('poll-vllm', 'active', null)
  const TIMEOUT_MS = 25 * 60 * 1000 // 25 minutes
  const POLL_INTERVAL = 15_000
  const startTime = Date.now()

  try {
    while (Date.now() - startTime < TIMEOUT_MS) {
      if (ctx.abortSignal.aborted) {
        throw new Error('Automation aborted by user')
      }

      // Check vLLM readiness
      try {
        const result = await sshExec(
          client,
          'curl -sf http://127.0.0.1:8000/v1/models',
          ctx.emitter,
          'poll-vllm',
          10_000,
        )
        if (result.includes('model')) {
          ctx.emitter.log('poll-vllm', 'VLLM_READY')
          ctx.emitter.updateStep('poll-vllm', 'done', null)
          return
        }
      } catch {
        // Not ready yet — check logs for fatal errors
      }

      // Tail the log for progress info
      try {
        const logTail = await sshExec(
          client,
          'tail -n 3 ~/gptoss-120b.log 2>/dev/null || echo "(no log yet)"',
          ctx.emitter,
          'poll-vllm',
          5_000,
        )

        // Check for fatal conditions
        const lower = logTail.toLowerCase()
        if (lower.includes('cuda out of memory') || lower.includes('oom')) {
          throw new Error(
            'vLLM ran out of GPU memory loading the 120B model. Check ~/gptoss-120b.log. Try reducing --gpu-memory-utilization to 0.90.',
          )
        }
        if (lower.includes('traceback') && lower.includes('error')) {
          throw new Error(
            `vLLM crashed during startup. Last log output:\n${logTail}`,
          )
        }
        if (
          lower.includes('no such file or directory') &&
          lower.includes('model')
        ) {
          throw new Error(
            `Model path not found. Last log output:\n${logTail}`,
          )
        }
      } catch (err) {
        if (
          err instanceof Error &&
          !err.message.includes('SSH command timed out')
        ) {
          throw err
        }
      }

      ctx.emitter.log('poll-vllm', 'VLLM_POLL: still loading...')
      await new Promise(r => setTimeout(r, POLL_INTERVAL))
    }

    // Timeout
    throw new Error(
      'vLLM has not become ready after 25 minutes. If this is a fresh instance, the model weights may still be downloading (~70GB). Check ~/gptoss-120b.log for download progress.',
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    ctx.emitter.updateStep('poll-vllm', 'error', msg)
    throw err
  }
}

async function stepPullBridge(
  client: SshClient,
  ctx: AutomationContext,
): Promise<void> {
  ctx.emitter.updateStep('pull-bridge', 'active', null)
  try {
    const commands = [
      'cd ~/claude-code-src-leaked',
      'git fetch origin codex/remote-glm-bridge',
      'git checkout -B codex/remote-glm-bridge origin/codex/remote-glm-bridge',
    ]
    await sshExec(
      client,
      commands.join(' && '),
      ctx.emitter,
      'pull-bridge',
      120_000,
    )
    ctx.emitter.updateStep('pull-bridge', 'done', null)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    ctx.emitter.updateStep('pull-bridge', 'error', msg)
    throw err
  }
}

async function stepStartBridge(
  client: SshClient,
  ctx: AutomationContext,
): Promise<string> {
  ctx.emitter.updateStep('start-bridge', 'active', null)
  try {
    const cmd = [
      `export PYTHONPATH="$HOME/claude-code-src-leaked"`,
      `export GPT_OSS_BRIDGE_API_KEYS="${ctx.bridgeApiKey}"`,
      `export GPT_OSS_BASE_URL="http://127.0.0.1:8000/v1"`,
      `export GPT_OSS_PRIMARY_MODEL="openai/gpt-oss-120b"`,
      `export GPT_OSS_FAST_BASE_URL="http://127.0.0.1:8000/v1"`,
      `export GPT_OSS_FAST_MODEL="openai/gpt-oss-120b"`,
      `export GPT_OSS_AUTO_MODEL_ALIAS="gpt-oss-auto"`,
      'nohup python3 -m uvicorn server.remote_glm_bridge.main:app \\',
      '  --host 0.0.0.0 --port 8787 > ~/jarvis-bridge.log 2>&1 &',
      'echo "BRIDGE_PID=$!"',
    ].join('\n')
    const output = await sshExec(client, cmd, ctx.emitter, 'start-bridge', 30_000)
    const pidMatch = output.match(/BRIDGE_PID=(\d+)/)
    const pid = pidMatch ? pidMatch[1] : 'unknown'
    ctx.emitter.log('start-bridge', `Bridge started with PID ${pid}`)
    ctx.emitter.updateStep('start-bridge', 'done', null)
    return pid
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    ctx.emitter.updateStep('start-bridge', 'error', msg)
    throw err
  }
}

async function stepPollBridge(
  client: SshClient,
  ctx: AutomationContext,
): Promise<void> {
  ctx.emitter.updateStep('poll-bridge', 'active', null)
  const TIMEOUT_MS = 3 * 60 * 1000 // 3 minutes
  const startTime = Date.now()

  try {
    while (Date.now() - startTime < TIMEOUT_MS) {
      if (ctx.abortSignal.aborted) {
        throw new Error('Automation aborted by user')
      }

      try {
        await sshExec(
          client,
          `curl -sf -H "X-Api-Key: ${ctx.bridgeApiKey}" http://127.0.0.1:8787/healthz`,
          ctx.emitter,
          'poll-bridge',
          10_000,
        )
        ctx.emitter.log('poll-bridge', 'BRIDGE_READY')
        ctx.emitter.updateStep('poll-bridge', 'done', null)
        return
      } catch {
        ctx.emitter.log('poll-bridge', 'BRIDGE_POLL: waiting...')
      }

      await new Promise(r => setTimeout(r, 5_000))
    }

    throw new Error(
      'Bridge process failed to start. Check ~/jarvis-bridge.log for Python errors.',
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    ctx.emitter.updateStep('poll-bridge', 'error', msg)
    throw err
  }
}

async function stepVerifyPorts(
  client: SshClient,
  ctx: AutomationContext,
): Promise<void> {
  ctx.emitter.updateStep('verify-ports', 'active', null)
  try {
    const output = await sshExec(
      client,
      "ss -ltnp | grep -E ':(8000|8787)\\b'",
      ctx.emitter,
      'verify-ports',
      10_000,
    )
    const has8000 = output.includes(':8000')
    const has8787 = output.includes(':8787')

    if (!has8000) {
      const logTail = await sshExec(
        client,
        'tail -n 10 ~/gptoss-120b.log 2>/dev/null || echo "(no log)"',
        ctx.emitter,
        'verify-ports',
        5_000,
      )
      throw new Error(`Port 8000 (vLLM) not listening.\n${logTail}`)
    }
    if (!has8787) {
      const logTail = await sshExec(
        client,
        'tail -n 10 ~/jarvis-bridge.log 2>/dev/null || echo "(no log)"',
        ctx.emitter,
        'verify-ports',
        5_000,
      )
      throw new Error(`Port 8787 (bridge) not listening.\n${logTail}`)
    }

    ctx.emitter.updateStep('verify-ports', 'done', null)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    ctx.emitter.updateStep('verify-ports', 'error', msg)
    throw err
  }
}

async function stepForwardPort(ctx: AutomationContext): Promise<string> {
  ctx.emitter.updateStep('forward-port', 'active', null)
  try {
    // Forward port 8787
    await execAsync('tnr ports forward 0 --add 8787', { timeout: 30_000 })
    ctx.emitter.log('forward-port', 'Port forward requested. Polling for public URL...')

    // Poll for port to appear in listing
    const TIMEOUT = 60_000
    const start = Date.now()
    while (Date.now() - start < TIMEOUT) {
      if (ctx.abortSignal.aborted) {
        throw new Error('Automation aborted by user')
      }

      const { stdout } = await execAsync('tnr ports list', { timeout: 10_000 })
      ctx.emitter.log('forward-port', stdout)

      // Look for a URL containing -8787
      const urlMatch = stdout.match(
        /(https:\/\/[\w-]+-8787\.thundercompute\.\w+)/,
      )
      if (urlMatch) {
        const publicUrl = urlMatch[1]
        ctx.emitter.log('forward-port', `Public URL: ${publicUrl}`)
        ctx.emitter.updateStep('forward-port', 'done', null)
        return publicUrl
      }

      await new Promise(r => setTimeout(r, 3_000))
    }

    throw new Error(
      'Port forwarding timed out. Port 8787 did not appear in tnr ports list.',
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    ctx.emitter.updateStep('forward-port', 'error', msg)
    throw err
  }
}

async function stepHealthCheck(
  publicUrl: string,
  ctx: AutomationContext,
): Promise<void> {
  ctx.emitter.updateStep('health-check', 'active', null)
  const TIMEOUT_MS = 3 * 60 * 1000 // 3 minutes
  const start = Date.now()

  try {
    while (Date.now() - start < TIMEOUT_MS) {
      if (ctx.abortSignal.aborted) {
        throw new Error('Automation aborted by user')
      }

      try {
        const response = await fetch(`${publicUrl}/healthz`, {
          headers: { 'X-Api-Key': ctx.bridgeApiKey },
          signal: AbortSignal.timeout(10_000),
        })
        if (response.ok) {
          ctx.emitter.log('health-check', 'Public URL is live. End-to-end verified.')
          ctx.emitter.updateStep('health-check', 'done', null)
          return
        }
      } catch {
        ctx.emitter.log('health-check', 'HEALTH_POLL: public URL not yet routable...')
      }

      await new Promise(r => setTimeout(r, 5_000))
    }

    throw new Error(
      'Bridge is running and ports are forwarded, but the public URL is not responding. This is usually a propagation delay. Wait 60 seconds and retry the health check.',
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    ctx.emitter.updateStep('health-check', 'error', msg)
    throw err
  }
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

export type AutomationResult = {
  publicUrl: string
  instanceId: string
}

/**
 * Run the full Phase 2 automation sequence.
 * Throws on any step failure with the step already marked as error.
 */
export async function runAutomation(
  instanceId: string,
  bridgeApiKey: string,
  mainWindow: BrowserWindow,
  emitter: StepEmitter,
  abortSignal: AbortSignal,
): Promise<AutomationResult> {
  const ctx: AutomationContext = {
    instanceId,
    bridgeApiKey,
    emitter,
    mainWindow,
    abortSignal,
  }

  // Step 1: Connect
  await stepConnectInstance(ctx)

  // Step 2: SSH info
  const sshInfo = await stepGetSshInfo(ctx)

  // Read private key
  const privateKey = await readFile(sshInfo.privateKeyPath)

  // Establish SSH connection
  const client = await connectSsh(sshInfo, privateKey)
  try {
    // Step 3A: System prep
    await stepSystemPrep(client, ctx)

    // Step 3B: Start vLLM
    await stepStartVllm(client, ctx)

    // Step 3C: Poll vLLM readiness (up to 25 minutes)
    await stepPollVllm(client, ctx)

    // Step 3D: Pull bridge code
    await stepPullBridge(client, ctx)

    // Step 3E: Start bridge
    await stepStartBridge(client, ctx)

    // Step 3F: Poll bridge readiness
    await stepPollBridge(client, ctx)

    // Step 3G: Verify ports
    await stepVerifyPorts(client, ctx)
  } finally {
    client.end()
  }

  // Step 4: Port forwarding (back on Windows)
  const publicUrl = await stepForwardPort(ctx)

  // Step 5: End-to-end health check
  await stepHealthCheck(publicUrl, ctx)

  // Step 6 is handled by the caller (save config)
  ctx.emitter.updateStep('save-config', 'active', null)

  return { publicUrl, instanceId }
}
