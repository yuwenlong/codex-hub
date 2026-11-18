& {
    $ErrorActionPreference = 'Stop'

    function Save-CodexHubDownload($url, $destination) {
        for ($attempt = 0; ; $attempt++) {
            try {
                Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $destination -TimeoutSec 60
                return
            } catch {
                if ($attempt -eq 3) { throw }
                $failure = $_.Exception
                $response = if ($failure.PSObject.Properties['Response']) { $failure.Response }
                $delay = [int][Math]::Pow(2, $attempt)
                if ($response) {
                    if ([int]$response.StatusCode -notin 408, 429, 500, 502, 503, 504, 522, 524) { throw }
                    $retryAfter = if ($response -is [System.Net.HttpWebResponse]) {
                        $response.Headers['Retry-After']
                    } else {
                        [string]$response.Headers.RetryAfter
                    }
                    [long]$seconds = 0
                    $date = [DateTimeOffset]::MinValue
                    if ([long]::TryParse($retryAfter, [ref]$seconds) -and $seconds -ge 0) {
                        $delay = $seconds
                    } elseif ($retryAfter -match '^[0-9]+$') {
                        throw
                    } elseif ([DateTimeOffset]::TryParse($retryAfter, [Globalization.CultureInfo]::InvariantCulture,
                            [Globalization.DateTimeStyles]::AssumeUniversal, [ref]$date)) {
                        $delay = [Math]::Max(0, [Math]::Ceiling(($date - [DateTimeOffset]::UtcNow).TotalSeconds))
                    }
                    if ($delay -gt 30) { throw }
                } elseif ($failure -is [System.Net.WebException]) {
                    if ([string]$failure.Status -notin 'ConnectFailure', 'ConnectionClosed', 'KeepAliveFailure',
                        'NameResolutionFailure', 'ProxyNameResolutionFailure', 'ReceiveFailure', 'SendFailure', 'Timeout') { throw }
                } else {
                    $cause = $failure.GetBaseException()
                    $networkError = $cause.PSObject.Properties['HttpRequestError'] -and
                        [string]$cause.HttpRequestError -in 'NameResolutionError', 'ConnectionError', 'ResponseEnded'
                    if (-not $networkError -and $cause -isnot [System.TimeoutException] -and
                        $cause -isnot [System.Net.Sockets.SocketException]) { throw }
                }
                Start-Sleep -Seconds $delay
            }
        }
    }

    $codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
    $runtime = Join-Path $codexHome 'codex-hub'
    $scripts = Join-Path $runtime 'scripts'
    $manager = Join-Path $scripts 'manage.mjs'
    $marker = Join-Path $runtime '.codex-hub-managed'
    $backup = Join-Path $codexHome 'codex-hub-statusline.json'
    $hasBackup = Test-Path -LiteralPath $backup
    $shellRecord = Join-Path $codexHome '.codex-hub-shell.json'
    $hasShellRecord = Get-Item -LiteralPath $shellRecord -Force -ErrorAction SilentlyContinue
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
        foreach ($file in 'lib/shell.mjs', 'lib/runtime-deps.mjs') {
            if (($file -cin $manifest) -and -not (Test-ManagedItem (Join-Path $runtime $file) $false)) { return $false }
        }
        if ($hasShellRecord -and ('lib/shell.mjs' -cnotin $manifest)) { return $false }
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
    } elseif ($pending -or $owned -or $hasBackup -or $hasShellRecord) {
        $url = 'https://raw.githubusercontent.com/yuwenlong/codex-hub/main/scripts/install.ps1'
        $bootstrapFile = [IO.Path]::GetTempFileName()
        try {
            Save-CodexHubDownload $url $bootstrapFile
            $bootstrap = Get-Content -LiteralPath $bootstrapFile -Encoding UTF8 -Raw
            if ([string]::IsNullOrWhiteSpace($bootstrap)) {
                throw 'codex-hub: The downloaded installer is empty.'
            }
            & ([scriptblock]::Create($bootstrap)) 'uninstall'
        } finally {
            Remove-Item -LiteralPath $bootstrapFile -Force -ErrorAction SilentlyContinue
        }
    } else {
        Write-Output 'codex-hub: No installation to remove.'
    }
}
