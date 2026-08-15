# uninstall.ps1 - roycode-dsh-pack rollback (idempotent).
# Removes: the 4 skills, 3 MCP server dirs, 2 cordis plugins and the patch
# block from cordis.patch.yml. Keeps typescript@5 and any .bak file.
param()
$ErrorActionPreference = 'Stop'

if ($env:DSH_HOME) { $DshHome = $env:DSH_HOME } else { $DshHome = Join-Path $HOME '.dsh' }
$SkillsRoot = Join-Path $DshHome 'skills'
$McpRoot = Join-Path $DshHome 'mcp-servers'
$ProfileRoot = Join-Path $DshHome 'profiles\web'
$PluginRoot = Join-Path $ProfileRoot 'node_modules'
$PatchPath = Join-Path $ProfileRoot 'cordis.patch.yml'

function Write-Step([string]$msg) { Write-Host "[roycode-dsh-pack] $msg" -ForegroundColor Cyan }

# -- 1. strip patch block --
if (Test-Path $PatchPath) {
  Write-Step "Stripping roycode-dsh-pack entries from $PatchPath"
  $content = [System.IO.File]::ReadAllText($PatchPath)
  $nl = "`r`n"
  if (-not $content.Contains("`r`n")) { $nl = "`n" }
  $lines = $content -split "`r?`n"
  $beginIdx = -1; $endIdx = -1
  for ($i = 0; $i -lt $lines.Length; $i++) {
    if ($lines[$i].Contains('roycode-dsh-pack-begin')) { $beginIdx = $i }
    if ($lines[$i].Contains('roycode-dsh-pack-end')) { $endIdx = $i }
  }
  if ($beginIdx -ge 0 -and $endIdx -gt $beginIdx) {
    $kept = @()
    for ($i = 0; $i -lt $lines.Length; $i++) { if ($i -lt $beginIdx -or $i -gt $endIdx) { $kept += $lines[$i] } }
    $newContent = ($kept -join $nl).TrimEnd("`r", "`n") + $nl
    [System.IO.File]::WriteAllText($PatchPath, $newContent, (New-Object System.Text.UTF8Encoding($false)))
    Write-Step "Patch block removed"
  } else {
    $legacyIdx = -1
    for ($i = 0; $i -lt $lines.Length; $i++) {
      if ($lines[$i].TrimStart().StartsWith('# RoyCode')) { $legacyIdx = $i; break }
    }
    if ($legacyIdx -ge 0) {
      $kept = @()
      for ($i = 0; $i -lt $lines.Length; $i++) { if ($i -lt $legacyIdx) { $kept += $lines[$i] } }
      $newContent = ($kept -join $nl).TrimEnd("`r", "`n") + $nl
      [System.IO.File]::WriteAllText($PatchPath, $newContent, (New-Object System.Text.UTF8Encoding($false)))
      Write-Step "Legacy RoyCode block removed"
    } else {
      Write-Step "No roycode-dsh-pack block found in patch; nothing to strip"
    }
  }
  # also strip the manage.ps1 disables section
  $dBegin = -1; $dEnd = -1
  for ($i = 0; $i -lt $lines.Length; $i++) {
    if ($lines[$i].Contains('roycode-dsh-pack-disables-begin')) { $dBegin = $i }
    if ($lines[$i].Contains('roycode-dsh-pack-disables-end')) { $dEnd = $i }
  }
  if ($dBegin -ge 0 -and $dEnd -gt $dBegin) {
    $kept = @()
    for ($i = 0; $i -lt $lines.Length; $i++) { if ($i -lt $dBegin -or $i -gt $dEnd) { $kept += $lines[$i] } }
    $newContent = ($kept -join $nl).TrimEnd("`r", "`n") + $nl
    [System.IO.File]::WriteAllText($PatchPath, $newContent, (New-Object System.Text.UTF8Encoding($false)))
    Write-Step "Disables section removed"
  }
} else {
  Write-Step "No patch file at $PatchPath"
}

# -- 2. skills --
foreach ($n in @('github-workflow', 'magic-docs', 'output-styles', 'scheduled-prompts')) {
  $dir = Join-Path $SkillsRoot $n
  if (Test-Path $dir) { Remove-Item $dir -Recurse -Force; Write-Step "Removed skill $n" }
}

# -- 3. MCP servers --
foreach ($s in @('lsp-server', 'secret-scan', 'browser')) {
  $dir = Join-Path $McpRoot $s
  if (Test-Path $dir) { Remove-Item $dir -Recurse -Force; Write-Step "Removed MCP server $s" }
}

# -- 4. cordis plugins --
foreach ($p in @('roycode-hooks', 'roycode-teams')) {
  $dir = Join-Path $PluginRoot $p
  if (Test-Path $dir) { Remove-Item $dir -Recurse -Force; Write-Step "Removed plugin $p" }
}

Write-Host ''
Write-Host 'roycode-dsh-pack uninstall complete.' -ForegroundColor Green
Write-Host "Backup of the original patch file (if any): $PatchPath.bak-roycode" -ForegroundColor Yellow
Write-Host 'Restart dsh web for changes to take effect.' -ForegroundColor Yellow