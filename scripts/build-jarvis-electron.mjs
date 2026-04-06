import { spawnSync } from 'child_process'
import { copyFile, cp, mkdir, rm, writeFile } from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import { build } from 'esbuild'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')
const outDir = path.join(repoRoot, 'dist-jarvis')
const rendererOutDir = path.join(outDir, 'renderer')
const thunderOutDir = path.join(outDir, 'thunder')
const distDesktopDir = path.join(repoRoot, 'dist-desktop')
const shouldPackage = process.argv.includes('--package')

// Native modules that cannot be bundled by esbuild
const NATIVE_EXTERNALS = ['node-pty', 'ssh2']

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32' && command.endsWith('.cmd'),
    ...options,
  })
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(' ')}`)
  }
}

function tryRunCommand(command, args, label) {
  try {
    runCommand(command, args)
  } catch (error) {
    console.warn(`[jarvis-build] ${label} skipped: ${error instanceof Error ? error.message : String(error)}`)
  }
}

await rm(outDir, { recursive: true, force: true })
await mkdir(rendererOutDir, { recursive: true })
await mkdir(thunderOutDir, { recursive: true })
await mkdir(distDesktopDir, { recursive: true })

await build({
  entryPoints: [path.join(repoRoot, 'desktop-electron', 'main.ts')],
  outfile: path.join(outDir, 'main.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron', ...NATIVE_EXTERNALS],
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
})

await build({
  entryPoints: [path.join(repoRoot, 'desktop-electron', 'preload.ts')],
  outfile: path.join(outDir, 'preload.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron'],
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
})

await build({
  entryPoints: [path.join(repoRoot, 'desktop-electron', 'renderer', 'main.tsx')],
  outfile: path.join(rendererOutDir, 'main.js'),
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'chrome124',
  jsx: 'automatic',
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
})

// Thunder terminal preload (separate BrowserWindow)
await build({
  entryPoints: [path.join(repoRoot, 'desktop-electron', 'thunder', 'terminalPreload.ts')],
  outfile: path.join(thunderOutDir, 'terminalPreload.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron'],
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
})

// Thunder terminal renderer (xterm.js in browser)
await build({
  entryPoints: [path.join(repoRoot, 'desktop-electron', 'thunder', 'terminalRenderer.ts')],
  outfile: path.join(thunderOutDir, 'terminalRenderer.js'),
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'chrome124',
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
})

await copyFile(
  path.join(repoRoot, 'desktop-electron', 'renderer', 'index.html'),
  path.join(rendererOutDir, 'index.html'),
)
await copyFile(
  path.join(repoRoot, 'desktop-electron', 'renderer', 'styles.css'),
  path.join(rendererOutDir, 'styles.css'),
)

// Thunder terminal HTML
await copyFile(
  path.join(repoRoot, 'desktop-electron', 'thunder', 'terminal.html'),
  path.join(thunderOutDir, 'terminal.html'),
)

// Copy native node modules so they're available at runtime
for (const mod of NATIVE_EXTERNALS) {
  const src = path.join(repoRoot, 'node_modules', mod)
  const dest = path.join(outDir, 'node_modules', mod)
  try {
    await cp(src, dest, { recursive: true })
  } catch (err) {
    console.warn(`[jarvis-build] Could not copy ${mod}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// ssh2 depends on cpu-features and asn1 — copy its transitive native deps too
const ssh2Deps = ['cpu-features']
for (const dep of ssh2Deps) {
  const src = path.join(repoRoot, 'node_modules', dep)
  const dest = path.join(outDir, 'node_modules', dep)
  try {
    await cp(src, dest, { recursive: true })
  } catch {
    // Optional native dep, skip if missing
  }
}

await writeFile(
  path.join(outDir, 'package.json'),
  JSON.stringify(
    {
      name: 'jarvis-desktop',
      version: '0.1.0',
      description: 'Jarvis desktop shell for the Claude-derived coding workspace.',
      author: 'Jarvis',
      main: 'main.cjs',
    },
    null,
    2,
  ),
  'utf8',
)

if (process.platform === 'win32') {
  runCommand('bun', [
    'build',
    '--compile',
    '--windows-hide-console',
    '--windows-title',
    'Jarvis Worker',
    '--windows-description',
    'Jarvis background runtime worker',
    '--outfile',
    path.join(distDesktopDir, 'JarvisWorker.exe'),
    'desktop-app/launcher.ts',
  ])

  tryRunCommand('bun', [
    'build',
    '--compile',
    '--windows-hide-console',
    '--windows-title',
    'Claude Code CLI',
    '--windows-description',
    'Headless Claude Code worker for Jarvis',
    '--outfile',
    path.join(distDesktopDir, 'ClaudeCodeCli.exe'),
    'entrypoints/cli.tsx',
  ], 'ClaudeCodeCli.exe compile')
}

if (shouldPackage) {
  runCommand(process.platform === 'win32' ? 'npx.cmd' : 'npx', [
    'electron-builder',
    '--config',
    'electron-builder.json',
  ])

  if (process.platform === 'win32') {
    await writeFile(
      path.join(distDesktopDir, 'Jarvis.cmd'),
      [
        '@echo off',
        'set "SCRIPT_DIR=%~dp0"',
        'start "" "%SCRIPT_DIR%electron\\win-unpacked\\Jarvis.exe"',
        '',
      ].join('\r\n'),
      'utf8',
    )
  }
}
