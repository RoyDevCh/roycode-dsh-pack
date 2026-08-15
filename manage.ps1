# manage.ps1 - roycode-dsh-pack plugin management (status/enable/disable/config).
# Disabled state lives in its own patch section OUTSIDE the install block, so
# re-running install.ps1 does not clobber it. Changes need a dsh web restart.
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\manage.ps1 status
#   powershell -ExecutionPolicy Bypass -File .\manage.ps1 disable <id>
#   powershell -ExecutionPolicy Bypass -File .\manage.ps1 enable <id>
#   powershell -ExecutionPolicy Bypass -File .\manage.ps1 config
param(
  [Parameter(Position = 0)][string]$Command = 'status',
  [Parameter(Position = 1)][string]$Id = ''
)
$ErrorActionPreference = 'Stop'

if ($env:DSH_HOME) { $DshHome = $env:DSH_HOME } else { $DshHome = Join-Path $HOME '.dsh' }
$PatchPath = Join-Path $DshHome 'profiles\web\cordis.patch.yml'
$PluginRoot = Join-Path $DshHome 'profiles\web\node_modules'
$SkillsRoot = Join-Path $DshHome 'skills'
$McpRoot = Join-Path $DshHome 'mcp-servers'

$PACK_IDS = @('mcp-lsp', 'mcp-secret-scan', 'mcp-browser', 'roycode-hooks', 'roycode-teams', 'schedule', 'roycode-triggers')
$BEGIN_MARKER = '# roycode-dsh-pack-disables-begin'
$END_MARKER = '# roycode-dsh-pack-disables-end'

function Get-DisabledSet {
  if (-not (Test-Path $PatchPath)) { return @() }
  $lines = [System.IO.File]::ReadAllLines($PatchPath)
  $in = $false
  $disabled = @()
  foreach ($line in $lines) {
    if ($line -match [regex]::Escape($BEGIN_MARKER)) { $in = $true; continue }
    if ($line -match [regex]::Escape($END_MARKER)) { $in = $false; continue }
    if ($in) {
      $m = [regex]::Match($line, '^-\s*id:\s*(\S+)\s*$')
      if ($m.Success) { $disabled += $m.Groups[1].Value }
    }
  }
  return $disabled
}

function Write-DisabledSection {
  param([string[]]$Disabled)
  $nl = "`r`n"
  if (-not [System.IO.File]::ReadAllText($PatchPath).Contains("`r`n")) { $nl = "`n" }
  $content = [System.IO.File]::ReadAllText($PatchPath)
  $lines = $content -split "`r?`n"
  $kept = @()
  $in = $false
  foreach ($line in $lines) {
    if ($line -match [regex]::Escape($BEGIN_MARKER)) { $in = $true; continue }
    if ($line -match [regex]::Escape($END_MARKER)) { $in = $false; continue }
    if (-not $in) { $kept += $line }
  }
  $out = ($kept -join $nl).TrimEnd("`r", "`n")
  if ($Disabled.Count -gt 0) {
    $out += $nl + $nl + $BEGIN_MARKER
    foreach ($id in $Disabled) {
      $out += $nl + '- id: ' + $id + $nl + '  disabled: true'
    }
    $out += $nl + $END_MARKER
  }
  $out += $nl
  [System.IO.File]::WriteAllText($PatchPath, $out, (New-Object System.Text.UTF8Encoding($false)))
}

function Show-Status {
  $disabled = @(Get-DisabledSet)
  Write-Host ''
  Write-Host 'roycode-dsh-pack entries:' -ForegroundColor Cyan
  foreach ($id in $PACK_IDS) {
    $isOff = $disabled -contains $id
    $state = if ($isOff) { 'DISABLED' } else { 'active' }
    $color = if ($isOff) { 'Yellow' } else { 'Green' }
    $kind = if ($id -like 'mcp-*') { 'mcp-server' } elseif ($id -eq 'schedule') { 'native' } else { 'cordis' }
    Write-Host ('  {0,-18} {1,-10} {2}' -f $id, $state, $kind) -ForegroundColor $color
  }
  $skillNames = @('github-workflow','magic-docs','output-styles','scheduled-prompts')
  $skills = @(Get-ChildItem $SkillsRoot -Directory -ErrorAction SilentlyContinue | Where-Object { $skillNames -contains $_.Name })
  $mcpDirs = @('lsp-server','secret-scan','browser' | Where-Object { Test-Path (Join-Path $McpRoot $_) })
  $pluginDirs = @('roycode-hooks','roycode-teams','roycode-triggers' | Where-Object { Test-Path (Join-Path $PluginRoot $_) })
  Write-Host ''
  Write-Host ('skills installed:    {0}/4' -f $skills.Count) -ForegroundColor Cyan
  Write-Host ('mcp servers dirs:   {0}/3' -f $mcpDirs.Count) -ForegroundColor Cyan
  Write-Host ('cordis plugin dirs: {0}/3' -f $pluginDirs.Count) -ForegroundColor Cyan
  Write-Host ''
  Write-Host 'Note: disabled entries take effect after a dsh web restart.' -ForegroundColor DarkGray
}

switch ($Command.ToLower()) {
  'status' { Show-Status }
  'disable' {
    if (-not $PACK_IDS -contains $Id) { throw "unknown entry id: $Id (valid: $($PACK_IDS -join ', '))" }
    $disabled = @(Get-DisabledSet)
    if ($disabled -contains $Id) { Write-Host "$Id already disabled" -ForegroundColor Yellow }
    else {
      $disabled = @($disabled + $Id | Sort-Object -Unique)
      Write-DisabledSection -Disabled $disabled
      Write-Host "$Id disabled (restart dsh web to apply)" -ForegroundColor Green
    }
  }
  'enable' {
    if (-not $PACK_IDS -contains $Id) { throw "unknown entry id: $Id (valid: $($PACK_IDS -join ', '))" }
    $disabled = @(Get-DisabledSet)
    if ($disabled -notcontains $Id) { Write-Host "$Id already enabled" -ForegroundColor Yellow }
    else {
      $disabled = @($disabled | Where-Object { $_ -ne $Id } | Sort-Object -Unique)
      Write-DisabledSection -Disabled $disabled
      Write-Host "$Id enabled (restart dsh web to apply)" -ForegroundColor Green
    }
  }
  'config' {
    $dshCmd = Get-Command dsh -ErrorAction SilentlyContinue
    if (-not $dshCmd) { throw 'dsh not on PATH' }
    $dump = & dsh --profile web --dump-config 2>&1 | Out-String
    foreach ($id in $PACK_IDS) {
      $found = $dump -match [regex]::Escape('- id: ' + $id)
      $color = if ($found) { 'Green' } else { 'Red' }
      $flag = if ($found) { 'composed' } else { 'MISSING' }
      Write-Host ('  {0,-18} {1}' -f $id, $flag) -ForegroundColor $color
    }
  }
  default { throw "unknown command: $Command (status|disable|enable|config)" }
}
