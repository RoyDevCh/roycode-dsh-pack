# install.ps1 - roycode-dsh-pack one-shot installer (idempotent).
# Installs: 4 skills, 3 MCP servers (lsp/secret-scan/browser), 2 cordis
# plugins (roycode-hooks/roycode-teams) and the cordis.patch.yml entries.
# Usage: powershell -ExecutionPolicy Bypass -File .\install.ps1 [-SkipNpm] [-SkipVerify]
# Requires: node + npm on PATH; dsh web profile booted at least once
# (so profiles/web/node_modules exists with @deepseek-ai deps).
param(
  [switch]$SkipNpm,
  [switch]$SkipVerify
)
$ErrorActionPreference = 'Stop'

$Pack = $PSScriptRoot
if ($env:DSH_HOME) { $DshHome = $env:DSH_HOME } else { $DshHome = Join-Path $HOME '.dsh' }
$SkillsRoot = Join-Path $DshHome 'skills'
$McpRoot = Join-Path $DshHome 'mcp-servers'
$ProfileRoot = Join-Path $DshHome 'profiles\web'
$PluginRoot = Join-Path $ProfileRoot 'node_modules'
$PatchPath = Join-Path $ProfileRoot 'cordis.patch.yml'

function Write-Step([string]$msg) { Write-Host "[roycode-dsh-pack] $msg" -ForegroundColor Cyan }

# -- 1. Skills --
Write-Step "Installing skills -> $SkillsRoot"
foreach ($n in @('github-workflow', 'magic-docs', 'output-styles', 'scheduled-prompts')) {
  $src = Join-Path $Pack "skills\$n\SKILL.md"
  if (-not (Test-Path $src)) { throw "Missing pack file: $src" }
  $dstDir = Join-Path $SkillsRoot $n
  New-Item -ItemType Directory -Force -Path $dstDir | Out-Null
  Copy-Item $src (Join-Path $dstDir 'SKILL.md') -Force
}

# -- 2. MCP servers --
Write-Step "Installing MCP servers -> $McpRoot"
foreach ($s in @('lsp-server', 'secret-scan', 'browser')) {
  $src = Join-Path $Pack "mcp\$s\server.mjs"
  if (-not (Test-Path $src)) { throw "Missing pack file: $src" }
  $dstDir = Join-Path $McpRoot $s
  New-Item -ItemType Directory -Force -Path $dstDir | Out-Null
  Copy-Item $src (Join-Path $dstDir 'server.mjs') -Force
}

# -- 3. typescript@5 (LSP dependency) --
$tsPkg = Join-Path $McpRoot 'node_modules\typescript\package.json'
$needTs = $true
if (Test-Path $tsPkg) {
  try {
    $tsVer = (Get-Content $tsPkg -Raw | ConvertFrom-Json).version
    if ($tsVer -like '5.*') { $needTs = $false }
  } catch {}
}
if ($needTs) {
  if ($SkipNpm) {
    Write-Warning 'typescript@5 missing; skipped because -SkipNpm. LSP server will fail until "npm install typescript@5" runs in mcp-servers.'
  } else {
    Write-Step "Installing typescript@5 in $McpRoot"
    Push-Location $McpRoot
    try { npm install typescript@5 --no-audit --no-fund | Out-Null } finally { Pop-Location }
    if (-not (Test-Path $tsPkg)) { throw 'npm install typescript@5 failed' }
  }
} else {
  Write-Step "typescript@5 already present (v$tsVer)"
}

# -- 4. Cordis plugins --
$depRoots = @(
  (Join-Path $PluginRoot '@deepseek-ai'),
  (Join-Path (Join-Path $DshHome 'profiles') 'node_modules\@deepseek-ai')
)
$depsOk = $false
foreach ($p in $depRoots) { if (Test-Path -LiteralPath $p) { $depsOk = $true } }
if (-not $depsOk) {
  Write-Warning "Could not find @deepseek-ai deps (checked $($depRoots -join '; ')). Boot 'dsh web' once so the profile store is populated, then re-run this installer."
}
Write-Step "Installing cordis plugins -> $PluginRoot"
foreach ($p in @('roycode-hooks', 'roycode-teams')) {
  foreach ($rel in @('package.json', 'lib\index.js')) {
    $src = Join-Path $Pack "plugins\$p\$rel"
    if (-not (Test-Path $src)) { throw "Missing pack file: $src" }
    $dst = Join-Path $PluginRoot "$p\$rel"
    New-Item -ItemType Directory -Force -Path (Split-Path $dst) | Out-Null
    Copy-Item $src $dst -Force
  }
}

# -- 5. cordis.patch.yml entries (idempotent block replace) --
$nodePath = (Get-Command node -ErrorAction Stop).Source
$block = @'
# roycode-dsh-pack-begin
    # -- LSP code intelligence (TS/JS: diagnostics/defs/refs/hover/symbols/rename) --
    - id: mcp-lsp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: lsp
        transport: stdio
        command: '@NODE@'
        args: ['@DSHHOME@\mcp-servers\lsp-server\server.mjs']
        toolCallTimeoutMs: 180000

    # -- secret scanning (API keys / tokens / private keys) --
    - id: mcp-secret-scan
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: secret-scan
        transport: stdio
        command: '@NODE@'
        args: ['@DSHHOME@\mcp-servers\secret-scan\server.mjs']

    # -- browser helper (open URL / google search in default browser) --
    - id: mcp-browser
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: browser
        transport: stdio
        command: '@NODE@'
        args: ['@DSHHOME@\mcp-servers\browser\server.mjs']

    # -- event hooks (roycode-hooks v2): programmable event engine --
    # runtime tools: hooks_rule_add (pending until user confirms) /
    #   hooks_rule_confirm / hooks_rule_remove / hooks_rule_list
    # common events: turn/start turn/end step/end tool/call tool/result user/message ...
    - id: roycode-hooks
      name: roycode-hooks
      config:
        storagePath: '@DSHHOME@\roycode-hooks.json'
        rules:
          - id: log-turn-end
            events: ['turn/end']
            command: powershell -NoProfile -Command Add-Content $env:USERPROFILE\.dsh\hooks.log (Get-Date -Format o)

    # -- subagent teams (roycode-teams): shared inbox + memory --
    - id: roycode-teams
      name: roycode-teams
      config:
        storagePath: '@DSHHOME@\roycode-teams.json'

    # -- durable reminders (dsh-schedule): schedule_create/list/delete tools --
    # session-local; fires as a later turn when the owning agent is idle;
    # overdue records persist and fire when that session is next resumed.
    - id: schedule
      name: '@deepseek-ai/dsh-schedule'

    # -- inbound webhooks (roycode-triggers): POST /trigger -> follow-up turn --
    # curl -X POST http://127.0.0.1:8787/trigger -H "content-type: application/json" -d "{\"message\":\"hello\"}"
    # optional: token (Bearer auth), target: latest|all, session id in payload
    - id: roycode-triggers
      name: roycode-triggers
      config:
        port: 8787
        host: '127.0.0.1'
        token: ''
        target: 'latest'
        patchPath: '@DSHHOME@\profiles\web\cordis.patch.yml'

    # -- custom plugins tab (roycode-inventory, client): Settings -> Plugins --
    # adds a "Custom" tab listing only the roycode-dsh-pack entries
    - id: roycode-inventory
      name: roycode-inventory

    # -- notebook cell editing (.ipynb) --
    - id: mcp-notebooks
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: notebooks
        transport: stdio
        command: '@NODE@'
        args: ['@DSHHOME@\mcp-servers\notebooks\server.mjs']

    # -- voice input/output (mic -> faster-whisper, SAPI TTS) --
    - id: mcp-voice
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: voice
        transport: stdio
        command: '@NODE@'
        args: ['@DSHHOME@\mcp-servers\voice\server.mjs']
        toolCallTimeoutMs: 180000
# roycode-dsh-pack-end
'@
$block = $block.Replace('@NODE@', $nodePath).Replace('@DSHHOME@', $DshHome)

New-Item -ItemType Directory -Force -Path $ProfileRoot | Out-Null
if (-not (Test-Path $PatchPath)) {
  Write-Step "Creating $PatchPath"
  $newContent = "# dsh patch layer for the web profile (generated by roycode-dsh-pack)`r`n- insert:`r`n" + $block + "`r`n"
  [System.IO.File]::WriteAllText($PatchPath, $newContent, (New-Object System.Text.UTF8Encoding($false)))
} else {
  Write-Step "Updating $PatchPath (backup + block replace)"
  $backup = "$PatchPath.bak-roycode"
  if (-not (Test-Path $backup)) { Copy-Item $PatchPath $backup }
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
    $before = ($lines[0..($beginIdx - 1)] -join $nl)
  } else {
    # legacy block (pre-marker installs): strip from the '# RoyCode' header to EOF
    $legacyIdx = -1
    for ($i = 0; $i -lt $lines.Length; $i++) {
      if ($lines[$i].TrimStart().StartsWith('# RoyCode')) { $legacyIdx = $i; break }
    }
    if ($legacyIdx -ge 0) { $before = ($lines[0..($legacyIdx - 1)] -join $nl) }
    else { $before = ($lines -join $nl) }
  }
  $before = $before.TrimEnd("`r", "`n")
  $newContent = $before + $nl + $nl + $block + $nl
  [System.IO.File]::WriteAllText($PatchPath, $newContent, (New-Object System.Text.UTF8Encoding($false)))
}

# -- 6. Verify --
if (-not $SkipVerify) {
  Write-Step 'Verifying syntax...'
  foreach ($file in @(
    (Join-Path $McpRoot 'lsp-server\server.mjs'),
    (Join-Path $McpRoot 'secret-scan\server.mjs'),
    (Join-Path $McpRoot 'browser\server.mjs'),
    (Join-Path $PluginRoot 'roycode-hooks\lib\index.js'),
    (Join-Path $PluginRoot 'roycode-teams\lib\index.js')
  )) {
    if (Test-Path $file) { & node --check $file; if ($LASTEXITCODE -ne 0) { throw "syntax check failed: $file" } }
  }
  $dshCmd = Get-Command dsh -ErrorAction SilentlyContinue
  if ($dshCmd) {
    Write-Step 'Composing config (dsh --profile web --dump-config)...'
    $dump = & dsh --profile web --dump-config 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { Write-Warning "dump-config failed (exit $LASTEXITCODE). Check $PatchPath" }
    foreach ($id in @('mcp-lsp', 'mcp-secret-scan', 'mcp-browser', 'roycode-hooks', 'roycode-teams', 'roycode-triggers', 'roycode-inventory', 'mcp-notebooks', 'mcp-voice')) {
      if ($dump -match [regex]::Escape($id)) { Write-Host "  [ok] $id" } else { Write-Warning "  [missing] $id in composed config" }
    }
  } else {
    Write-Warning 'dsh not on PATH; skipped config verification'
  }
}

Write-Host ''
Write-Host 'roycode-dsh-pack install complete.' -ForegroundColor Green
Write-Host 'Restart dsh web to load MCP servers and cordis plugins (skills hot-reload, no restart needed).' -ForegroundColor Yellow
Write-Host "Uninstall: powershell -ExecutionPolicy Bypass -File `"$Pack\uninstall.ps1`"" -ForegroundColor Yellow