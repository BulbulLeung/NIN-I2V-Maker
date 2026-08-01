import { app } from 'electron'
import { existsSync, readdirSync, statSync, mkdirSync, copyFileSync, rmSync } from 'fs'
import { access, constants, mkdir, writeFile } from 'fs/promises'
import { basename, dirname, join } from 'path'
import { spawn, execFile, type ChildProcess } from 'child_process'
import { promisify } from 'util'
import WebSocket from 'ws'

const execFileAsync = promisify(execFile)

export const COMFY_DEFAULT_PORT = 8188
export const COMFY_BASE_URL = `http://127.0.0.1:${COMFY_DEFAULT_PORT}`

export interface ComfyInstallProgress {
  stage: string
  message: string
  pct: number
}

type ProgressFn = (p: ComfyInstallProgress) => void

let installCancelled = false
let comfyProc: ChildProcess | null = null
/** Last successfully started ComfyUI install root (for resolving output images). */
let lastComfyInstallRoot: string | null = null

type ComfyLogListener = (payload: { line: string; stream: 'stdout' | 'stderr' }) => void
let comfyLogListener: ComfyLogListener | null = null

export function setComfyLogListener(listener: ComfyLogListener | null): void {
  comfyLogListener = listener
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '')
}

/** Split process output into lines; treat `\r` as a line break (tqdm progress). */
function emitComfyOutputChunk(
  chunk: Buffer,
  stream: 'stdout' | 'stderr',
  state: { buf: string }
): void {
  state.buf += chunk.toString('utf8')
  state.buf = state.buf.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const parts = state.buf.split('\n')
  state.buf = parts.pop() ?? ''
  for (const raw of parts) {
    const line = stripAnsi(raw).trimEnd()
    if (!line) continue
    comfyLogListener?.({ line, stream })
  }
}

export function defaultComfyInstallPath(downloadFolder?: string): string {
  const root = (downloadFolder || '').trim() || app.getPath('userData')
  return join(root, 'ComfyUI')
}

export function batPathForInstall(installRoot: string): string {
  return join(installRoot, 'run_i2vmaker.bat')
}

/** Bundled custom nodes live in resources/comfy_custom_nodes (dev + packaged). */
function bundledCustomNodesRoot(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'comfy_custom_nodes')
  }
  return join(process.cwd(), 'resources', 'comfy_custom_nodes')
}

function copyDirRecursive(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true })
  for (const name of readdirSync(src)) {
    const from = join(src, name)
    const to = join(dest, name)
    const st = statSync(from)
    if (st.isDirectory()) {
      copyDirRecursive(from, to)
    } else {
      copyFileSync(from, to)
    }
  }
}

/**
 * Install / refresh NIN I2V Maker ComfyUI custom nodes (direct multi-codec save).
 * Returns a fingerprint so launch can restart Comfy when nodes change.
 */
export function ensureNinComfyCustomNodes(installRoot: string): { ok: boolean; fingerprint: string; error?: string } {
  const srcRoot = bundledCustomNodesRoot()
  if (!existsSync(srcRoot)) {
    return { ok: false, fingerprint: '', error: `Bundled custom nodes missing: ${srcRoot}` }
  }
  const destRoot = join(installRoot, 'custom_nodes')
  try {
    mkdirSync(destRoot, { recursive: true })
    const parts: string[] = []
    for (const name of readdirSync(srcRoot)) {
      const from = join(srcRoot, name)
      if (!statSync(from).isDirectory()) continue
      const to = join(destRoot, name)
      if (existsSync(to)) {
        rmSync(to, { recursive: true, force: true })
      }
      copyDirRecursive(from, to)
      // Fingerprint node sources
      const initPy = join(to, '__init__.py')
      if (existsSync(initPy)) {
        const st = statSync(initPy)
        parts.push(`${name}:${st.size}:${st.mtimeMs}`)
      } else {
        parts.push(name)
      }
    }
    return { ok: true, fingerprint: parts.sort().join('|') }
  } catch (err) {
    return {
      ok: false,
      fingerprint: '',
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

function resolvePythonExe(pythonPath?: string): string {
  const trimmed = (pythonPath || '').trim()
  if (trimmed) return trimmed
  return process.platform === 'win32' ? 'python' : 'python3'
}

/** I2V Maker layout: `{download}/python/venv/Scripts/python.exe` + `{download}/python/tools/uv.exe`. */
function findUvBesidePython(pythonExe: string): string | null {
  const scriptsOrBin = dirname(pythonExe)
  const venvDir = dirname(scriptsOrBin)
  const installRoot = dirname(venvDir)
  const uvName = process.platform === 'win32' ? 'uv.exe' : 'uv'
  const candidates = [
    join(installRoot, 'tools', uvName),
    join(venvDir, 'tools', uvName),
    join(dirname(pythonExe), uvName)
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return null
}

async function hasPipModule(pythonExe: string): Promise<boolean> {
  try {
    await execFileAsync(pythonExe, ['-c', 'import pip'], {
      timeout: 15000,
      windowsHide: true
    })
    return true
  } catch {
    return false
  }
}

async function torchAudioLoads(pythonExe: string): Promise<boolean> {
  try {
    await execFileAsync(
      pythonExe,
      ['-c', 'import torchaudio; import torchaudio.lib._torchaudio'],
      { timeout: 60000, windowsHide: true }
    )
    return true
  } catch {
    return false
  }
}

async function readTorchVersion(pythonExe: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      pythonExe,
      ['-c', 'import torch; print(torch.__version__)'],
      { timeout: 30000, windowsHide: true, encoding: 'utf8' }
    )
    const v = (stdout || '').trim()
    return v || null
  } catch {
    return null
  }
}

/**
 * ComfyUI requirements may pull a mismatched torchaudio (e.g. 2.11) that fails to load
 * against I2V Maker's torch 2.9.1+cu128 (Windows 0xc0000139 / CDLL error).
 */
async function alignTorchAudio(
  pythonExe: string,
  cwd: string,
  onProgress?: ProgressFn
): Promise<void> {
  if (await torchAudioLoads(pythonExe)) return

  const torchVer = (await readTorchVersion(pythonExe)) || '2.9.1+cu128'
  const base = torchVer.split('+')[0] || '2.9.1'
  const cudaTag = /cu\d+/i.exec(torchVer)?.[0]?.toLowerCase() || 'cu128'
  const indexUrl = `https://download.pytorch.org/whl/${cudaTag}`
  const uv = findUvBesidePython(pythonExe)

  onProgress?.({
    stage: 'pip',
    message: `Repairing torchaudio to match torch ${torchVer}…`,
    pct: 72
  })

  if (uv) {
    try {
      await runLogged(uv, ['pip', 'uninstall', '-y', '--python', pythonExe, 'torchaudio'], {
        cwd,
        onProgress,
        stage: 'pip'
      })
    } catch {
      /* may not be installed */
    }
    await runLogged(
      uv,
      ['pip', 'install', '--python', pythonExe, `torchaudio==${base}`, '--index-url', indexUrl],
      { cwd, onProgress, stage: 'pip' }
    )
  } else {
    try {
      await runLogged(pythonExe, ['-m', 'pip', 'uninstall', '-y', 'torchaudio'], {
        cwd,
        onProgress,
        stage: 'pip'
      })
    } catch {
      /* ignore */
    }
    await runLogged(
      pythonExe,
      ['-m', 'pip', 'install', `torchaudio==${base}`, '--index-url', indexUrl],
      { cwd, onProgress, stage: 'pip' }
    )
  }

  if (!(await torchAudioLoads(pythonExe))) {
    throw new Error(
      `torchaudio still fails to load after aligning to torch ${torchVer}. ` +
        `Try reinstalling I2V Maker Python, then ComfyUI Download again.`
    )
  }
}

async function installComfyRequirements(
  pythonExe: string,
  requirementsPath: string,
  cwd: string,
  onProgress?: ProgressFn
): Promise<void> {
  const uv = findUvBesidePython(pythonExe)
  if (uv) {
    onProgress?.({
      stage: 'pip',
      message: `Installing ComfyUI requirements via uv…`,
      pct: 50
    })
    await runLogged(uv, ['pip', 'install', '--python', pythonExe, '-r', requirementsPath], {
      cwd,
      onProgress,
      stage: 'pip'
    })
    await alignTorchAudio(pythonExe, cwd, onProgress)
    return
  }

  if (!(await hasPipModule(pythonExe))) {
    onProgress?.({
      stage: 'pip',
      message: 'Bootstrapping pip (ensurepip)…',
      pct: 48
    })
    try {
      await runLogged(pythonExe, ['-m', 'ensurepip', '--upgrade'], {
        cwd,
        onProgress,
        stage: 'pip'
      })
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      throw new Error(
        `This Python has no pip, and ensurepip failed. Use I2V Maker Python Download (uv) or install pip manually. ${detail}`
      )
    }
  }

  onProgress?.({
    stage: 'pip',
    message: 'Installing ComfyUI requirements…',
    pct: 55
  })
  await runLogged(pythonExe, ['-m', 'pip', 'install', '-r', requirementsPath], {
    cwd,
    onProgress,
    stage: 'pip'
  })
  await alignTorchAudio(pythonExe, cwd, onProgress)
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK)
    return true
  } catch {
    return false
  }
}

export async function probeComfyBat(
  batPath: string
): Promise<{ ok: boolean; message: string; installRoot?: string }> {
  const trimmed = (batPath || '').trim()
  if (!trimmed) {
    return { ok: false, message: 'ComfyUI launch bat not set' }
  }
  if (!(await pathExists(trimmed))) {
    return { ok: false, message: `Bat not found: ${trimmed}` }
  }
  const installRoot = dirname(trimmed)
  const mainPy = join(installRoot, 'main.py')
  if (!(await pathExists(mainPy))) {
    return {
      ok: false,
      message: `main.py not found next to bat (expected ${mainPy})`,
      installRoot
    }
  }
  return { ok: true, message: 'ComfyUI install looks valid', installRoot }
}

function buildBatContents(
  installRoot: string,
  pythonExe: string,
  useSageAttention = true
): string {
  const py = pythonExe.replace(/"/g, '')
  const sage = useSageAttention ? ' --use-sage-attention' : ''
  return `@echo off
cd /d "${installRoot}"
"${py}" main.py --disable-auto-launch --port ${COMFY_DEFAULT_PORT}${sage}
`
}

export async function writeExtraModelPaths(
  installRoot: string,
  opts: {
    modelsRoot?: string
    loraFolders?: string[]
    /** Parent dirs of DiT .safetensors → diffusion_models / unet */
    ditFolders?: string[]
    /** Parent dirs of VAE .safetensors */
    vaeFolders?: string[]
    /** Parent dirs of text-encoder .safetensors */
    clipFolders?: string[]
    /** Parent dirs of upscale model weights → upscale_models */
    upscaleFolders?: string[]
    /** Parent dirs of frame interpolation model weights → frame_interpolation */
    frameInterpFolders?: string[]
  }
): Promise<void> {
  const lines: string[] = ['# Generated by NIN I2V Maker — do not edit while app is managing ComfyUI', '']
  const modelsRoot = (opts.modelsRoot || '').trim()
  if (modelsRoot) {
    lines.push('i2vmaker_models:')
    lines.push(`    base_path: ${modelsRoot.replace(/\\/g, '/')}`)
    lines.push('    checkpoints: .')
    lines.push('    diffusion_models: .')
    lines.push('    unet: .')
    lines.push('    clip: .')
    lines.push('    vae: .')
    lines.push('    loras: .')
    lines.push('    upscale_models: .')
    lines.push('    frame_interpolation: .')
    lines.push('')
  }
  const uniq = (arr: string[] | undefined) =>
    [...new Set((arr || []).map((p) => (p || '').trim()).filter(Boolean))]

  uniq(opts.ditFolders).forEach((folder, i) => {
    lines.push(`i2vmaker_dit_${i}:`)
    lines.push(`    base_path: ${folder.replace(/\\/g, '/')}`)
    lines.push('    diffusion_models: .')
    lines.push('    unet: .')
    lines.push('')
  })
  uniq(opts.vaeFolders).forEach((folder, i) => {
    lines.push(`i2vmaker_vae_${i}:`)
    lines.push(`    base_path: ${folder.replace(/\\/g, '/')}`)
    lines.push('    vae: .')
    lines.push('')
  })
  uniq(opts.clipFolders).forEach((folder, i) => {
    lines.push(`i2vmaker_clip_${i}:`)
    lines.push(`    base_path: ${folder.replace(/\\/g, '/')}`)
    lines.push('    clip: .')
    lines.push('')
  })
  uniq(opts.loraFolders).forEach((folder, i) => {
    lines.push(`i2vmaker_lora_${i}:`)
    lines.push(`    base_path: ${folder.replace(/\\/g, '/')}`)
    lines.push('    loras: .')
    lines.push('')
  })
  uniq(opts.upscaleFolders).forEach((folder, i) => {
    lines.push(`i2vmaker_upscale_${i}:`)
    lines.push(`    base_path: ${folder.replace(/\\/g, '/')}`)
    lines.push('    upscale_models: .')
    lines.push('')
  })
  uniq(opts.frameInterpFolders).forEach((folder, i) => {
    lines.push(`i2vmaker_frame_interp_${i}:`)
    lines.push(`    base_path: ${folder.replace(/\\/g, '/')}`)
    lines.push('    frame_interpolation: .')
    lines.push('')
  })
  await writeFile(join(installRoot, 'extra_model_paths.yaml'), lines.join('\n'), 'utf8')
}

async function runLogged(
  cmd: string,
  args: string[],
  opts: {
    cwd?: string
    onProgress?: ProgressFn
    stage?: string
    env?: NodeJS.ProcessEnv
  } = {}
): Promise<void> {
  if (installCancelled) throw new Error('Cancelled')
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      windowsHide: true,
      shell: false
    })
    let stderr = ''
    child.stdout.on('data', (buf: Buffer) => {
      const line = buf.toString('utf8').trim()
      if (line && opts.onProgress) {
        opts.onProgress({
          stage: opts.stage || 'run',
          message: line.slice(0, 200),
          pct: 0
        })
      }
    })
    child.stderr.on('data', (buf: Buffer) => {
      stderr += buf.toString('utf8')
    })
    child.on('error', (err) => reject(err))
    child.on('close', (code) => {
      if (installCancelled) {
        reject(new Error('Cancelled'))
        return
      }
      if (code !== 0) {
        reject(new Error(`${cmd} ${args.join(' ')} failed (${code}): ${stderr.slice(-800)}`))
        return
      }
      resolve()
    })
  })
}

export function cancelComfyInstall(): { ok: boolean } {
  installCancelled = true
  return { ok: true }
}

export async function installComfyUi(opts: {
  downloadFolder?: string
  pythonPath?: string
  onProgress?: ProgressFn
}): Promise<{ ok: boolean; batPath?: string; message: string; installRoot?: string }> {
  installCancelled = false
  const onProgress = opts.onProgress
  const installRoot = defaultComfyInstallPath(opts.downloadFolder)
  const pythonExe = resolvePythonExe(opts.pythonPath)
  const batPath = batPathForInstall(installRoot)

  try {
    onProgress?.({ stage: 'prepare', message: `Install root: ${installRoot}`, pct: 5 })
    await mkdir(dirname(installRoot), { recursive: true })

    const mainPy = join(installRoot, 'main.py')
    if (await pathExists(mainPy)) {
      onProgress?.({ stage: 'git', message: 'ComfyUI already present; pulling latest…', pct: 20 })
      try {
        await runLogged('git', ['-C', installRoot, 'pull', '--ff-only'], {
          onProgress,
          stage: 'git'
        })
      } catch (err) {
        onProgress?.({
          stage: 'git',
          message: `git pull skipped: ${err instanceof Error ? err.message : String(err)}`,
          pct: 25
        })
      }
    } else {
      onProgress?.({
        stage: 'git',
        message: 'Cloning ComfyUI (requires git on PATH)…',
        pct: 15
      })
      if (await pathExists(installRoot)) {
        // Empty or incomplete dir — try clone into it fails; remove not automatic for safety
      }
      try {
        await runLogged(
          'git',
          ['clone', '--depth', '1', 'https://github.com/comfyanonymous/ComfyUI.git', installRoot],
          { onProgress, stage: 'git' }
        )
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return {
          ok: false,
          message: `git clone failed. Install Git and retry. ${msg}`,
          installRoot
        }
      }
    }

    if (installCancelled) return { ok: false, message: 'Cancelled', installRoot }

    onProgress?.({
      stage: 'pip',
      message: 'Installing ComfyUI requirements (using I2V Maker Python)…',
      pct: 45
    })
    const req = join(installRoot, 'requirements.txt')
    if (await pathExists(req)) {
      await installComfyRequirements(pythonExe, req, installRoot, onProgress)
    }

    if (installCancelled) return { ok: false, message: 'Cancelled', installRoot }

    onProgress?.({ stage: 'bat', message: 'Writing run_i2vmaker.bat…', pct: 85 })
    await writeFile(batPath, buildBatContents(installRoot, pythonExe), 'utf8')

    const nodes = ensureNinComfyCustomNodes(installRoot)
    if (!nodes.ok) {
      onProgress?.({
        stage: 'nodes',
        message: `Custom nodes warning: ${nodes.error}`,
        pct: 90
      })
    }

    const modelsRoot = opts.downloadFolder
      ? join(opts.downloadFolder.trim() || app.getPath('userData'), 'models')
      : join(app.getPath('userData'), 'models')
    await writeExtraModelPaths(installRoot, { modelsRoot })

    onProgress?.({ stage: 'done', message: 'ComfyUI ready', pct: 100 })
    return {
      ok: true,
      batPath,
      installRoot,
      message: `Installed at ${installRoot}`
    }
  } catch (err) {
    return {
      ok: false,
      installRoot,
      message: err instanceof Error ? err.message : String(err)
    }
  }
}

export async function isComfyServerOnline(baseUrl = COMFY_BASE_URL): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/system_stats`, { signal: AbortSignal.timeout(2000) })
    return res.ok
  } catch {
    return false
  }
}

export function comfyStatus(): { running: boolean; pid?: number; installRoot?: string; outputDir?: string } {
  const installRoot = lastComfyInstallRoot || undefined
  const outputDir = installRoot ? join(installRoot, 'output') : undefined
  if (comfyProc && !comfyProc.killed) {
    return { running: true, pid: comfyProc.pid, installRoot, outputDir }
  }
  return { running: false, installRoot, outputDir }
}

export function getComfyInstallRoot(): string {
  return lastComfyInstallRoot || defaultComfyInstallPath()
}

export function getComfyOutputDir(): string {
  return join(getComfyInstallRoot(), 'output')
}

/** Resolve a Comfy /history image ref to an absolute filesystem path. */
export function resolveComfyImagePath(img: {
  filename: string
  subfolder?: string
  type?: string
}): string {
  const root = getComfyInstallRoot()
  const kind = (img.type || 'output').toLowerCase()
  const base =
    kind === 'temp' ? join(root, 'temp') : kind === 'input' ? join(root, 'input') : join(root, 'output')
  const sub = (img.subfolder || '').replace(/^[/\\]+/, '').replace(/\\/g, '/')
  return sub ? join(base, ...sub.split('/'), img.filename) : join(base, img.filename)
}

export async function stopComfyUi(): Promise<{ ok: boolean }> {
  disconnectComfyProgressWs()
  if (!comfyProc) {
    lastExtraPathsKey = ''
    return { ok: true }
  }
  const proc = comfyProc
  comfyProc = null
  lastExtraPathsKey = ''
  try {
    if (process.platform === 'win32' && proc.pid) {
      await execFileAsync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true })
    } else {
      proc.kill('SIGTERM')
    }
  } catch {
    try {
      proc.kill('SIGKILL')
    } catch {
      /* ignore */
    }
  }
  return { ok: true }
}

async function stopComfyProcessOnly(): Promise<void> {
  if (!comfyProc) return
  const proc = comfyProc
  comfyProc = null
  try {
    if (process.platform === 'win32' && proc.pid) {
      await execFileAsync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true })
    } else {
      proc.kill('SIGTERM')
    }
  } catch {
    try {
      proc.kill('SIGKILL')
    } catch {
      /* ignore */
    }
  }
}

let lastExtraPathsKey = ''

function extraPathsKey(opts: {
  modelsRoot?: string
  loraFolders?: string[]
  ditFolders?: string[]
  vaeFolders?: string[]
  clipFolders?: string[]
  upscaleFolders?: string[]
  frameInterpFolders?: string[]
  useSageAttention?: boolean
  customNodesFingerprint?: string
}): string {
  return JSON.stringify({
    modelsRoot: (opts.modelsRoot || '').trim(),
    loraFolders: (opts.loraFolders || []).map((p) => p.trim()).filter(Boolean).sort(),
    ditFolders: (opts.ditFolders || []).map((p) => p.trim()).filter(Boolean).sort(),
    vaeFolders: (opts.vaeFolders || []).map((p) => p.trim()).filter(Boolean).sort(),
    clipFolders: (opts.clipFolders || []).map((p) => p.trim()).filter(Boolean).sort(),
    upscaleFolders: (opts.upscaleFolders || []).map((p) => p.trim()).filter(Boolean).sort(),
    frameInterpFolders: (opts.frameInterpFolders || []).map((p) => p.trim()).filter(Boolean).sort(),
    useSageAttention: Boolean(opts.useSageAttention),
    customNodesFingerprint: opts.customNodesFingerprint || ''
  })
}

export async function startComfyUi(opts: {
  batPath: string
  pythonPath?: string
  modelsRoot?: string
  loraFolders?: string[]
  ditFolders?: string[]
  vaeFolders?: string[]
  clipFolders?: string[]
  upscaleFolders?: string[]
  frameInterpFolders?: string[]
  useSageAttention?: boolean
}): Promise<{ ok: boolean; error?: string; alreadyRunning?: boolean }> {
  const probe = await probeComfyBat(opts.batPath)
  if (!probe.ok || !probe.installRoot) {
    return { ok: false, error: probe.message }
  }
  const installRoot = probe.installRoot
  const useSageAttention = Boolean(opts.useSageAttention)
  const nodes = ensureNinComfyCustomNodes(installRoot)
  if (!nodes.ok) {
    return { ok: false, error: nodes.error || 'Failed to install NIN ComfyUI custom nodes' }
  }
  const pathKey = extraPathsKey({ ...opts, useSageAttention, customNodesFingerprint: nodes.fingerprint })
  await writeExtraModelPaths(installRoot, {
    modelsRoot: opts.modelsRoot,
    loraFolders: opts.loraFolders,
    ditFolders: opts.ditFolders,
    vaeFolders: opts.vaeFolders,
    clipFolders: opts.clipFolders,
    upscaleFolders: opts.upscaleFolders,
    frameInterpFolders: opts.frameInterpFolders
  })

  if (await isComfyServerOnline()) {
    if (pathKey === lastExtraPathsKey) {
      lastComfyInstallRoot = installRoot
      return { ok: true, alreadyRunning: true }
    }
    // Model search paths or SageAttention flag changed; ComfyUI only applies at boot.
    await stopComfyProcessOnly()
  } else if (comfyProc && !comfyProc.killed) {
    if (pathKey === lastExtraPathsKey) {
      lastComfyInstallRoot = installRoot
      return { ok: true, alreadyRunning: true }
    }
    await stopComfyProcessOnly()
  }

  lastExtraPathsKey = pathKey

  const pythonExe = resolvePythonExe(opts.pythonPath)
  await stopComfyProcessOnly()

  // Keep run_i2vmaker.bat in sync with current SageAttention preference.
  try {
    await writeFile(
      join(installRoot, 'run_i2vmaker.bat'),
      buildBatContents(installRoot, pythonExe, useSageAttention),
      'utf8'
    )
  } catch {
    /* best-effort */
  }

  // Repair mismatched torchaudio before spawn (common after ComfyUI requirements install).
  try {
    const preOk = await torchAudioLoads(pythonExe)
    if (!preOk) {
      await alignTorchAudio(pythonExe, installRoot)
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    }
  }

  const args = ['main.py', '--disable-auto-launch', '--port', String(COMFY_DEFAULT_PORT)]
  if (useSageAttention) args.push('--use-sage-attention')

  return new Promise((resolve) => {
    const child = spawn(pythonExe, args, {
      cwd: installRoot,
      windowsHide: true,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    comfyProc = child
    lastComfyInstallRoot = installRoot
    let settled = false
    let stdoutBuf = ''
    let stderrBuf = ''
    const stdoutLine = { buf: '' }
    const stderrLine = { buf: '' }
    child.stdout?.on('data', (buf: Buffer) => {
      stdoutBuf += buf.toString('utf8')
      if (stdoutBuf.length > 8000) stdoutBuf = stdoutBuf.slice(-8000)
      emitComfyOutputChunk(buf, 'stdout', stdoutLine)
    })
    child.stderr?.on('data', (buf: Buffer) => {
      stderrBuf += buf.toString('utf8')
      if (stderrBuf.length > 8000) stderrBuf = stderrBuf.slice(-8000)
      emitComfyOutputChunk(buf, 'stderr', stderrLine)
    })
    const fail = (error: string) => {
      if (settled) return
      settled = true
      if (comfyProc === child) comfyProc = null
      const detail = [stderrBuf.trim(), stdoutBuf.trim()].filter(Boolean).join('\n').slice(-1200)
      resolve({ ok: false, error: detail ? `${error}\n${detail}` : error })
    }
    child.on('error', (err) => fail(err.message))
    child.on('exit', (code) => {
      if (comfyProc === child) comfyProc = null
      if (!settled) {
        fail(`ComfyUI exited early (code ${code})`)
      }
    })

    const startedAt = Date.now()
    const poll = async () => {
      if (settled) return
      if (await isComfyServerOnline()) {
        settled = true
        resolve({ ok: true })
        return
      }
      if (Date.now() - startedAt > 120_000) {
        fail('ComfyUI did not become ready within 120s')
        return
      }
      setTimeout(() => void poll(), 1000)
    }
    setTimeout(() => void poll(), 1500)
  })
}

export function comfyInstallRootFromBat(batPath: string): string {
  return dirname((batPath || '').trim())
}

export function comfyBatBasename(batPath: string): string {
  return basename((batPath || '').trim() || 'run_i2vmaker.bat')
}

export function comfyExistsSync(p: string): boolean {
  return existsSync(p)
}

export type ComfyWsEvent = {
  type: string
  data?: {
    value?: number
    max?: number
    node?: string | null
    prompt_id?: string
  }
}

type ComfyWsListener = (event: ComfyWsEvent) => void

let progressWs: WebSocket | null = null
let progressWsListener: ComfyWsListener | null = null

export function disconnectComfyProgressWs(): void {
  const ws = progressWs
  progressWs = null
  progressWsListener = null
  if (!ws) return
  try {
    ws.removeAllListeners()
    ws.close()
  } catch {
    /* ignore */
  }
}

/**
 * Connect to ComfyUI `/ws` in the main process (reliable vs renderer WS).
 * Must be open before POST /prompt with the same clientId, or sampling progress is lost.
 */
export async function connectComfyProgressWs(opts: {
  baseUrl: string
  clientId: string
  onEvent: ComfyWsListener
  timeoutMs?: number
}): Promise<{ ok: boolean; error?: string }> {
  disconnectComfyProgressWs()

  let wsUrl = ''
  try {
    const u = new URL((opts.baseUrl || COMFY_BASE_URL).replace(/\/$/, ''))
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
    u.pathname = '/ws'
    u.search = `clientId=${encodeURIComponent(opts.clientId)}`
    wsUrl = u.toString()
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }

  const timeoutMs = opts.timeoutMs ?? 8_000
  progressWsListener = opts.onEvent

  return new Promise((resolve) => {
    let settled = false
    let ws: WebSocket
    try {
      ws = new WebSocket(wsUrl)
    } catch (err) {
      progressWsListener = null
      resolve({ ok: false, error: err instanceof Error ? err.message : String(err) })
      return
    }
    progressWs = ws

    const finish = (result: { ok: boolean; error?: string }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    const timer = setTimeout(() => {
      disconnectComfyProgressWs()
      finish({ ok: false, error: `WebSocket connect timeout (${timeoutMs}ms)` })
    }, timeoutMs)

    ws.on('open', () => {
      finish({ ok: true })
    })

    ws.on('error', (err) => {
      if (!settled) {
        disconnectComfyProgressWs()
        finish({
          ok: false,
          error: err instanceof Error ? err.message : `WebSocket error connecting to ${wsUrl}`
        })
      }
    })

    ws.on('close', () => {
      if (progressWs === ws) {
        progressWs = null
        progressWsListener = null
      }
      if (!settled) {
        finish({ ok: false, error: 'WebSocket closed before open' })
      }
    })

    ws.on('message', (data, isBinary) => {
      const listener = progressWsListener
      if (!listener || isBinary) return
      const text = typeof data === 'string' ? data : Buffer.from(data as Buffer).toString('utf8')
      try {
        const parsed = JSON.parse(text) as ComfyWsEvent
        if (parsed && typeof parsed.type === 'string') {
          listener(parsed)
        }
      } catch {
        /* ignore */
      }
    })
  })
}


