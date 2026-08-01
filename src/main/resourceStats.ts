import { basename } from 'path'
import { cpus, freemem, totalmem } from 'os'
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)
function parseCudaIndex(device: string): string | null {
  const d = (device || '').trim().toLowerCase()
  if (d.startsWith('cuda:')) return d.slice(5)
  if (d === 'cuda') return '0'
  return null
}

interface CpuSample {
  idle: number
  total: number
}

export interface GpuVramApp {
  pid: number
  name: string
  memUsedMiB: number
  killable: boolean
}

export interface GpuResourceStats {
  id: string
  name: string
  utilPercent: number
  memUsedMiB: number
  memTotalMiB: number
  tempC: number | null
  powerDrawW: number | null
  powerLimitW: number | null
  apps: GpuVramApp[]
}

export interface ResourceStats {
  cpuName: string
  cpuPercent: number
  ramUsedBytes: number
  ramTotalBytes: number
  gpu: GpuResourceStats | null
}

let lastCpuSample: CpuSample | null = null
let cachedCpuName: string | null = null

function getCpuName(): string {
  if (cachedCpuName !== null) return cachedCpuName
  const list = cpus()
  const model = list[0]?.model?.trim() || ''
  cachedCpuName = model || 'Unknown CPU'
  return cachedCpuName
}

function sampleCpu(): CpuSample {
  let idle = 0
  let total = 0
  for (const cpu of cpus()) {
    idle += cpu.times.idle
    total +=
      cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq
  }
  return { idle, total }
}

function getCpuUsagePercent(): number {
  const current = sampleCpu()
  if (!lastCpuSample) {
    lastCpuSample = current
    return 0
  }
  const idleDelta = current.idle - lastCpuSample.idle
  const totalDelta = current.total - lastCpuSample.total
  lastCpuSample = current
  if (totalDelta <= 0) return 0
  const usage = 1 - idleDelta / totalDelta
  return Math.round(Math.min(100, Math.max(0, usage * 100)) * 10) / 10
}

const PROTECTED_PROCESS_NAMES = new Set(
  [
    'system',
    'registry',
    'smss',
    'smss.exe',
    'csrss',
    'csrss.exe',
    'wininit',
    'wininit.exe',
    'services',
    'services.exe',
    'lsass',
    'lsass.exe',
    'svchost',
    'svchost.exe',
    'dwm',
    'dwm.exe',
    'explorer',
    'explorer.exe',
    'winlogon',
    'winlogon.exe',
    'fontdrvhost',
    'fontdrvhost.exe',
    'sihost',
    'sihost.exe',
    'taskhostw',
    'taskhostw.exe',
    'runtimebroker',
    'runtimebroker.exe',
    'searchhost',
    'searchhost.exe',
    'startmenuexperiencehost',
    'startmenuexperiencehost.exe',
    'shellexperiencehost',
    'shellexperiencehost.exe',
    'textinputhost',
    'textinputhost.exe',
    'lockapp',
    'lockapp.exe',
    'applicationframehost',
    'applicationframehost.exe',
    'systemsettings',
    'systemsettings.exe',
    'memory compression',
    'secure system',
    'idle',
    'systemd',
    'init'
  ].map((s) => s.toLowerCase())
)

const WIN_PROTECTED_PATH_MARKERS = [
  '\\windows\\',
  '\\windowsapps\\',
  '\\systemapps\\',
  '\\program files\\windows defender\\',
  '\\program files (x86)\\windows defender\\'
]

const LINUX_PROTECTED_PATH_PREFIXES = ['/usr/lib/systemd', '/sbin/', '/usr/sbin/', '/lib/systemd']

function normalizeProcessName(name: string): string {
  return name.trim().toLowerCase()
}

function normalizeExePath(exePath: string): string {
  return exePath.trim().toLowerCase().replace(/\//g, '\\')
}

/** True when exePath is this app's binary (dev electron.exe or packaged I2V Maker.exe). */
function isOwnAppExePath(exePath: string | null | undefined): boolean {
  if (!exePath?.trim()) return false
  return normalizeExePath(exePath) === normalizeExePath(process.execPath)
}

function isProtectedGpuProcess(pid: number, name: string, exePath: string | null): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return true
  if (pid === process.pid) return true
  if (typeof process.ppid === 'number' && pid === process.ppid) return true
  if (isOwnAppExePath(exePath)) return true

  const normName = normalizeProcessName(name)
  const base = normalizeProcessName(basename((exePath || name).replace(/\\/g, '/')))
  if (PROTECTED_PROCESS_NAMES.has(normName) || PROTECTED_PROCESS_NAMES.has(base)) {
    return true
  }

  const pathLower = (exePath || '').trim().toLowerCase().replace(/\//g, '\\')
  if (process.platform === 'win32') {
    if (!pathLower) {
      // No path usually means elevated / system process we cannot safely kill
      return true
    }
    if (WIN_PROTECTED_PATH_MARKERS.some((m) => pathLower.includes(m))) return true
    return false
  }

  const unixPath = (exePath || '').trim().toLowerCase()
  if (!unixPath) return true
  if (LINUX_PROTECTED_PATH_PREFIXES.some((p) => unixPath.startsWith(p))) return true
  return false
}

/** Soft cap for IPC payload; UI may show fewer based on panel height (min 12). */
const GPU_VRAM_APPS_FETCH_LIMIT = 64

function finalizeGpuVramApps(
  apps: { pid: number; name: string; memUsedMiB: number; path?: string | null }[]
): GpuVramApp[] {
  return apps
    .filter((a) => Number.isFinite(a.memUsedMiB) && a.memUsedMiB >= 1 && a.name)
    .sort((a, b) => b.memUsedMiB - a.memUsedMiB)
    .slice(0, GPU_VRAM_APPS_FETCH_LIMIT)
    .map((a) => {
      const own = isOwnAppExePath(a.path)
      const killable = !isProtectedGpuProcess(a.pid, a.name, a.path ?? null)
      return {
        pid: a.pid,
        name: own ? 'I2V Maker' : a.name,
        memUsedMiB: Math.round(a.memUsedMiB * 10) / 10,
        killable
      }
    })
}

async function resolveProcessIdentity(
  pid: number
): Promise<{ name: string; path: string | null } | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null
  try {
    if (process.platform === 'win32') {
      const script = `
$ErrorActionPreference = 'SilentlyContinue'
$proc = Get-Process -Id ${pid} -ErrorAction SilentlyContinue
if (-not $proc) { '' } else {
  $name = if ($proc.Path) { [System.IO.Path]::GetFileName($proc.Path) } else { $proc.ProcessName }
  (@{ name = $name; path = $proc.Path }) | ConvertTo-Json -Compress
}
`.trim()
      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { timeout: 5000, windowsHide: true, encoding: 'utf8' }
      )
      const text = stdout.trim()
      if (!text) return null
      const parsed = JSON.parse(text) as { name?: string; path?: string | null }
      return {
        name: String(parsed.name || ''),
        path: parsed.path ? String(parsed.path) : null
      }
    }
    const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'comm=', '-o', 'args='], {
      timeout: 3000,
      encoding: 'utf8'
    })
    const line = stdout.trim()
    if (!line) return null
    const parts = line.split(/\s+/)
    const name = parts[0] || ''
    const pathGuess = parts.find((p) => p.startsWith('/')) || null
    return { name, path: pathGuess }
  } catch {
    return null
  }
}

async function getParentPid(pid: number): Promise<number | null> {
  try {
    if (process.platform === 'win32') {
      const script = `
$ErrorActionPreference = 'SilentlyContinue'
$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue
if ($p -and $p.ParentProcessId) { $p.ParentProcessId } else { '' }
`.trim()
      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { timeout: 5000, windowsHide: true, encoding: 'utf8' }
      )
      const n = Number(stdout.trim())
      return Number.isInteger(n) && n > 0 ? n : null
    }
    const { stdout } = await execFileAsync('ps', ['-o', 'ppid=', '-p', String(pid)], {
      timeout: 3000,
      encoding: 'utf8'
    })
    const n = Number(stdout.trim())
    return Number.isInteger(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

/** Climb to the topmost killable ancestor so watchdog parents cannot respawn the VRAM process. */
async function findKillableProcessRoot(
  pid: number,
  name: string,
  exePath: string | null
): Promise<{ pid: number; name: string; path: string | null }> {
  let current = { pid, name, path: exePath }
  const visited = new Set<number>([pid])
  for (let i = 0; i < 8; i++) {
    const parentPid = await getParentPid(current.pid)
    if (!parentPid || parentPid <= 4 || visited.has(parentPid)) break
    visited.add(parentPid)
    const parent = await resolveProcessIdentity(parentPid)
    if (!parent?.name) break
    if (isProtectedGpuProcess(parentPid, parent.name, parent.path)) break
    current = { pid: parentPid, name: parent.name, path: parent.path }
  }
  return current
}

export async function killProcessByPid(pid: number): Promise<{ ok: boolean; error?: string }> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { ok: false, error: 'Invalid pid' }
  }
  const identity = await resolveProcessIdentity(pid)
  if (!identity || !identity.name) {
    return { ok: false, error: 'Process not found' }
  }
  if (isProtectedGpuProcess(pid, identity.name, identity.path)) {
    return { ok: false, error: 'Protected process' }
  }
  const root = await findKillableProcessRoot(pid, identity.name, identity.path)
  try {
    if (process.platform === 'win32') {
      await execFileAsync('taskkill', ['/pid', String(root.pid), '/T', '/F'], {
        timeout: 10000,
        windowsHide: true,
        encoding: 'utf8'
      })
      const stillTarget = await resolveProcessIdentity(pid)
      if (stillTarget) {
        return { ok: false, error: 'Process still running after kill' }
      }
      return { ok: true }
    }
    try {
      process.kill(root.pid, 'SIGTERM')
    } catch {
      process.kill(root.pid, 'SIGKILL')
    }
    return { ok: true }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Failed to kill process'
    }
  }
}

function parseTrailingNumber(parts: string[], offsetFromEnd: number): number {
  return Number(parts[parts.length - 1 - offsetFromEnd])
}

async function listGpuVramAppsWin(gpuIndex: number): Promise<GpuVramApp[]> {
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$idx = ${gpuIndex}
$byPid = @{}
$samples = (Get-Counter '\\GPU Process Memory(*)\\Dedicated Usage').CounterSamples
foreach ($s in $samples) {
  if ($s.InstanceName -match 'pid_(\\d+).*_phys_(\\d+)') {
    $procId = [int]$Matches[1]
    $phys = [int]$Matches[2]
    if ($phys -ne $idx) { continue }
    if (-not $byPid.ContainsKey($procId)) { $byPid[$procId] = [double]0 }
    $byPid[$procId] += [double]$s.CookedValue
  }
}
$rows = New-Object System.Collections.Generic.List[object]
foreach ($procId in @($byPid.Keys)) {
  $mib = [math]::Round($byPid[$procId] / 1MB, 1)
  if ($mib -lt 1) { continue }
  $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
  if (-not $proc) { continue }
  $name = if ($proc.Path) { [System.IO.Path]::GetFileName($proc.Path) } else { $proc.ProcessName }
  if (-not $name) { continue }
  [void]$rows.Add([pscustomobject]@{ pid = $procId; name = $name; memUsedMiB = $mib; path = $proc.Path })
}
$sorted = @($rows | Sort-Object memUsedMiB -Descending | Select-Object -First 12)
if ($sorted.Count -eq 0) { '[]' } else { $sorted | ConvertTo-Json -Compress }
`.trim()

  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { timeout: 15000, windowsHide: true, encoding: 'utf8' }
  )
  const text = stdout.trim()
  if (!text) return []
  const parsed = JSON.parse(text) as
    | { pid: number; name: string; memUsedMiB: number; path?: string | null }
    | { pid: number; name: string; memUsedMiB: number; path?: string | null }[]
  const rows = Array.isArray(parsed) ? parsed : [parsed]
  return finalizeGpuVramApps(
    rows.map((r) => ({
      pid: Number(r.pid),
      name: String(r.name || ''),
      memUsedMiB: Number(r.memUsedMiB),
      path: r.path ? String(r.path) : null
    }))
  )
}

async function listGpuVramAppsSmi(gpuIndex: number): Promise<GpuVramApp[]> {
  const { stdout } = await execFileAsync(
    'nvidia-smi',
    [
      '-i',
      String(gpuIndex),
      '--query-compute-apps=pid,process_name,used_gpu_memory',
      '--format=csv,noheader,nounits'
    ],
    { timeout: 5000, windowsHide: true, encoding: 'utf8' }
  )
  const byPid = new Map<number, { pid: number; name: string; memUsedMiB: number; path: string | null }>()
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const parts = trimmed.split(',').map((s) => s.trim())
    if (parts.length < 3) continue
    const pid = Number(parts[0])
    const memRaw = parts[parts.length - 1]
    if (/n\/a/i.test(memRaw)) continue
    const memUsedMiB = Number(memRaw)
    const pathOrName = parts.slice(1, -1).join(',')
    if (!Number.isInteger(pid) || pid < 0 || !Number.isFinite(memUsedMiB)) continue
    const name = basename(pathOrName.replace(/\\/g, '/')) || pathOrName
    if (!name || /insufficient permissions/i.test(name)) continue
    const exePath = pathOrName.includes('/') || pathOrName.includes('\\') ? pathOrName : null
    const existing = byPid.get(pid)
    if (existing) {
      existing.memUsedMiB += memUsedMiB
    } else {
      byPid.set(pid, { pid, name, memUsedMiB, path: exePath })
    }
  }
  return finalizeGpuVramApps([...byPid.values()])
}

async function listGpuVramApps(gpuIndex: number): Promise<GpuVramApp[]> {
  try {
    if (process.platform === 'win32') {
      return await listGpuVramAppsWin(gpuIndex)
    }
    return await listGpuVramAppsSmi(gpuIndex)
  } catch {
    return []
  }
}

async function getGpuStats(deviceId: string): Promise<GpuResourceStats | null> {
  const indexStr = parseCudaIndex(deviceId)
  if (indexStr === null) return null
  const targetIndex = Number(indexStr)
  if (!Number.isInteger(targetIndex) || targetIndex < 0) return null
  try {
    const { stdout } = await execFileAsync(
      'nvidia-smi',
      [
        '-i',
        String(targetIndex),
        '--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit',
        '--format=csv,noheader,nounits'
      ],
      { timeout: 5000, windowsHide: true, encoding: 'utf8' }
    )
    const trimmed = stdout.trim().split(/\r?\n/)[0]?.trim()
    if (!trimmed) return null
    const parts = trimmed.split(',').map((s) => s.trim())
    // name[, ...], util, memUsed, memTotal, temp, powerDraw, powerLimit
    if (parts.length < 7) return null
    const powerLimit = parseTrailingNumber(parts, 0)
    const powerDraw = parseTrailingNumber(parts, 1)
    const temp = parseTrailingNumber(parts, 2)
    const memTotal = parseTrailingNumber(parts, 3)
    const memUsed = parseTrailingNumber(parts, 4)
    const util = parseTrailingNumber(parts, 5)
    const name = parts.slice(0, parts.length - 6).join(', ')
    const apps = await listGpuVramApps(targetIndex)
    return {
      id: `cuda:${targetIndex}`,
      name: name || `cuda:${targetIndex}`,
      utilPercent: Number.isFinite(util) ? util : 0,
      memUsedMiB: Number.isFinite(memUsed) ? memUsed : 0,
      memTotalMiB: Number.isFinite(memTotal) ? memTotal : 0,
      tempC: Number.isFinite(temp) ? temp : null,
      powerDrawW: Number.isFinite(powerDraw) ? powerDraw : null,
      powerLimitW: Number.isFinite(powerLimit) ? powerLimit : null,
      apps
    }
  } catch {
    return null
  }
}

export async function getResourceStats(deviceId?: string): Promise<ResourceStats> {
  const ramTotalBytes = totalmem()
  const ramUsedBytes = Math.max(0, ramTotalBytes - freemem())
  const gpu = deviceId?.trim() ? await getGpuStats(deviceId.trim()) : null
  return {
    cpuName: getCpuName(),
    cpuPercent: getCpuUsagePercent(),
    ramUsedBytes,
    ramTotalBytes,
    gpu
  }
}
