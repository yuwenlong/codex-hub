& {
    $ErrorActionPreference = 'Stop'
    $codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
    $runtime = Join-Path $codexHome 'codex-hub'
    $scripts = Join-Path $runtime 'scripts'
    $manager = Join-Path $scripts 'manage.mjs'
    $marker = Join-Path $runtime '.codex-hub-managed'
    $backup = Join-Path $codexHome 'codex-hub-statusline.json'
    $hasBackup = Test-Path -LiteralPath $backup
    $transaction = Join-Path $codexHome '.codex-hub-transaction.json'
    $pending = Get-Item -LiteralPath $transaction -Force -ErrorAction SilentlyContinue

    function Test-ManagedItem($path, [bool]$container) {
        $item = Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
        $item -and $item.PSIsContainer -eq $container -and -not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)
    }

    $manifest = @()
    if (-not $pending -and (Test-ManagedItem $runtime $true) -and (Test-ManagedItem $marker $false)) {
        $manifest = @(Get-Content -LiteralPath $marker)
    }
    $owned = $manifest.Count -gt 1 -and $manifest[0] -ceq 'codex-hub-runtime-v1'
    function Test-LocalRuntime {
        if (-not ($owned -and ('scripts/manage.mjs' -cin $manifest) -and
            (Test-ManagedItem $scripts $true) -and (Test-ManagedItem $manager $false))) {
            return $false
        }
        # The manager loads configuration modules even without a backup.
        foreach ($folder in 'bin', 'lib') {
            if (-not (Test-ManagedItem (Join-Path $runtime $folder) $true)) { return $false }
        }
        foreach ($file in 'bin/codex-hub.mjs', 'package.json', 'lib/app-server.mjs', 'lib/installation.mjs') {
            if (-not (Test-ManagedItem (Join-Path $runtime $file) $false)) { return $false }
        }
        return $true
    }

    function Test-PendingFooterMigration {
        if (-not (Test-ManagedItem $backup $false)) { return $false }
        try {
            $metadata = Get-Content -LiteralPath $backup -Encoding UTF8 -Raw | ConvertFrom-Json
            return $metadata.version -eq 2
        } catch {
            return $false
        }
    }

    # A legacy runtime cannot restore both possible values from a pending footer migration.
    if ((Test-LocalRuntime) -and -not (Test-PendingFooterMigration)) {
        $node = (Get-Command node -CommandType Application -ErrorAction SilentlyContinue).Source
        if (-not $node) {
            throw 'codex-hub: Node.js 22 or newer is required on PATH.'
        }
        $major = & $node -p "process.versions.node.split('.')[0]"
        if ($LASTEXITCODE -ne 0 -or [int]$major -lt 22) {
            throw 'codex-hub: Node.js 22 or newer is required on PATH.'
        }
        & $node $manager 'uninstall'
        if ($LASTEXITCODE -ne 0) {
            throw "codex-hub: Uninstall failed (exit code $LASTEXITCODE)."
        }
    } elseif ($pending -or $owned -or $hasBackup) {
        $url = 'https://raw.githubusercontent.com/yuwenlong/codex-hub/main/scripts/install.ps1'
        $bootstrap = Invoke-RestMethod -UseBasicParsing -Uri $url
        if ([string]::IsNullOrWhiteSpace($bootstrap)) {
            throw 'codex-hub: The downloaded installer is empty.'
        }
        & ([scriptblock]::Create($bootstrap)) 'uninstall'
    } else {
        Write-Output 'codex-hub: No installation to remove.'
    }
}
