param(
    [ValidateSet('install', 'uninstall')]
    [string]$CodexHudAction = 'install'
)

& {
    $ErrorActionPreference = 'Stop'

    function Save-CodexHudDownload($url, $destination) {
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

    $node = (Get-Command node -CommandType Application -ErrorAction SilentlyContinue).Source
    if (-not $node) {
        throw 'codex-hud: Node.js 22 or newer is required on PATH.'
    }
    $major = & $node -p "process.versions.node.split('.')[0]"
    if ($LASTEXITCODE -ne 0 -or [int]$major -lt 22) {
        throw 'codex-hud: Node.js 22 or newer is required on PATH.'
    }
    if ($CodexHudAction -eq 'install' -and -not (Get-Command codex -CommandType Application -ErrorAction SilentlyContinue)) {
        throw 'codex-hud: Codex CLI is required on PATH.'
    }
    if (-not (Get-Command Expand-Archive -ErrorAction SilentlyContinue)) {
        throw 'codex-hud: Expand-Archive is required.'
    }

    $tempDir = Join-Path ([IO.Path]::GetTempPath()) ('codex-hud-' + [guid]::NewGuid().ToString('N'))
    [IO.Directory]::CreateDirectory($tempDir) | Out-Null
    try {
        $archive = Join-Path $tempDir 'codex-hud.zip'
        $package = Join-Path $tempDir 'package'
        $releaseUrl = 'https://github.com/yuwenlong/codex-hud/releases/latest/download/codex-hud.zip'
        Save-CodexHudDownload $releaseUrl $archive
        Expand-Archive -LiteralPath $archive -DestinationPath $package
        $manager = Join-Path $package 'codex-hud/scripts/manage.mjs'
        if (-not (Test-Path -LiteralPath $manager -PathType Leaf)) {
            throw 'codex-hud: The release ZIP does not contain the installer.'
        }
        $codexHudPreviousProfile = $env:CODEX_HUD_PS_PROFILE
        try {
            $env:CODEX_HUD_PS_PROFILE = $PROFILE.CurrentUserAllHosts
            & $node $manager $CodexHudAction
            if ($LASTEXITCODE -ne 0) {
                throw "codex-hud: $CodexHudAction failed (exit code $LASTEXITCODE)."
            }
        } finally {
            $env:CODEX_HUD_PS_PROFILE = $codexHudPreviousProfile
        }
    } finally {
        Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}
