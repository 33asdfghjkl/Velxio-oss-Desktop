<#
.SYNOPSIS
  Installs the unofficial Velxio desktop wrapper for the current user.

.DESCRIPTION
  Lays the app out under a destination folder and creates a desktop shortcut.

  Why this script exists instead of shipping the electron-builder output:
  Windows Smart App Control (and similar WDAC policies) block unsigned
  executables that Microsoft has no reputation record for. electron-builder
  RENAMES and REWRITES Electron's executable, which changes its hash and
  destroys that reputation - so the packaged .exe is refused with
  "An Application Control policy has blocked this file".

  The unmodified Electron binary that npm installs DOES carry reputation, so
  this script installs that binary untouched and loads the app from a normal
  directory (Electron's "run an app directory" mode). app.isPackaged is false
  in that mode, which is exactly the layout desktop/main.cjs and
  desktop/lib/backend.cjs already support.

.PARAMETER Destination
  Install folder. Default: D:\Program Files\Velxio OSS Desktop

.PARAMETER NoShortcut
  Do not create the desktop shortcut.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File desktop\scripts\install-windows.ps1
#>
[CmdletBinding()]
param(
  [string] $Destination = 'D:\Program Files\Velxio OSS Desktop',
  [switch] $NoShortcut
)

$ErrorActionPreference = 'Stop'

$RepoRoot  = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Electron  = Join-Path $RepoRoot 'desktop\node_modules\electron\dist'
$FrontendD = Join-Path $RepoRoot 'frontend\dist'
$BackendD  = Join-Path $RepoRoot 'backend'
$ToolsD    = Join-Path $RepoRoot '.tools\arduino-cli'
$IconSrc   = Join-Path $RepoRoot 'desktop\build\icon.ico'

function Say($m) { Write-Host $m }
function Fail($m) { Write-Host ('ERROR: ' + $m) -ForegroundColor Red; exit 1 }

Say '=== Velxio OSS Desktop (Unofficial) - Windows installer ==='
Say ('repo root  : ' + $RepoRoot)
Say ('destination: ' + $Destination)
Say ''

if (-not (Test-Path (Join-Path $Electron 'electron.exe'))) {
  Fail ('Electron is not installed. Run: cd desktop; npm install')
}
if (-not (Test-Path (Join-Path $FrontendD 'index.html'))) {
  Fail ('Frontend is not built. Run: cd frontend; npm install; npx vite build')
}
if (-not (Test-Path (Join-Path $BackendD 'app\main.py'))) {
  Fail ('Backend source is missing: ' + (Join-Path $BackendD 'app\main.py'))
}
if (-not (Test-Path (Join-Path $BackendD 'venv\Scripts\python.exe'))) {
  Say 'WARNING: backend\venv not found. The app will fall back to a system Python,'
  Say '         which usually lacks FastAPI/uvicorn, so compiling sketches will be'
  Say '         unavailable. See desktop/README.md for the venv setup.'
  Say ''
}

Say 'Installing files (this can take a minute)...'
if (Test-Path $Destination) { Remove-Item $Destination -Recurse -Force }
New-Item -ItemType Directory -Force -Path $Destination | Out-Null

robocopy $Electron $Destination /E /NFL /NDL /NJH /NJS /NP | Out-Null
Say ('  electron       rc=' + $LASTEXITCODE)

robocopy (Join-Path $RepoRoot 'desktop') (Join-Path $Destination 'desktop') /E /XD node_modules release /NFL /NDL /NJH /NJS /NP | Out-Null
Say ('  desktop        rc=' + $LASTEXITCODE)

robocopy $FrontendD (Join-Path $Destination 'frontend\dist') /E /NFL /NDL /NJH /NJS /NP | Out-Null
Say ('  frontend/dist  rc=' + $LASTEXITCODE)

robocopy $BackendD (Join-Path $Destination 'backend') /E /XD __pycache__ .pytest_cache /NFL /NDL /NJH /NJS /NP | Out-Null
Say ('  backend        rc=' + $LASTEXITCODE)

if (Test-Path $ToolsD) {
  robocopy $ToolsD (Join-Path $Destination '.tools\arduino-cli') /E /NFL /NDL /NJH /NJS /NP | Out-Null
  Say ('  arduino-cli    rc=' + $LASTEXITCODE)
} else {
  Say '  arduino-cli    skipped (optional: .tools/arduino-cli)'
}

if (Test-Path $IconSrc) { Copy-Item $IconSrc (Join-Path $Destination 'icon.ico') -Force }

Say ''
Say 'Verifying layout:'
$required = @('electron.exe', 'desktop\main.cjs', 'desktop\package.json', 'frontend\dist\index.html', 'backend\app\main.py')
$missing = 0
foreach ($rel in $required) {
  $ok = Test-Path (Join-Path $Destination $rel)
  if (-not $ok) { $missing++ }
  Say ('  ' + $(if ($ok) { 'ok  ' } else { 'MISS' }) + ' ' + $rel)
}
if ($missing -gt 0) { Fail 'install is incomplete' }

$sizeMb = [math]::Round(((Get-ChildItem $Destination -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum / 1MB), 0)
Say ('  total size: ' + $sizeMb + ' MB')

if (-not $NoShortcut) {
  Say ''
  Say 'Creating desktop shortcut...'
  $desktop = [Environment]::GetFolderPath('Desktop')
  Get-ChildItem $desktop -Filter '*Velxio*.lnk' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue

  $lnk = Join-Path $desktop 'Velxio OSS Desktop (Unofficial).lnk'
  $shell = New-Object -ComObject WScript.Shell
  $sc = $shell.CreateShortcut($lnk)
  $sc.TargetPath = Join-Path $Destination 'electron.exe'
  $sc.Arguments = '"' + (Join-Path $Destination 'desktop') + '"'
  $sc.WorkingDirectory = $Destination
  if (Test-Path (Join-Path $Destination 'icon.ico')) {
    $sc.IconLocation = Join-Path $Destination 'icon.ico'
  }
  $sc.Description = 'Unofficial community desktop wrapper for Velxio. Not affiliated with the Velxio project.'
  $sc.Save()
  Say ('  ' + $lnk)
}

Say ''
Say 'Done. Launch from the desktop shortcut, or directly:'
Say ('  "' + (Join-Path $Destination 'electron.exe') + '" "' + (Join-Path $Destination 'desktop') + '"')
Say ''
Say 'The first launch is slow: with arduino-cli on PATH the backend syncs its'
Say 'package indexes before it binds, so compiling becomes available about a'
Say 'minute in. Editing and the in-browser AVR / RP2040 simulation work at once.'
