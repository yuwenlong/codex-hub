param(
    [ValidateSet('install', 'uninstall')]
    [string]$CodexHubAction = 'install'
)

& {
    $ErrorActionPreference = 'Stop'
    $node = (Get-Command node -CommandType Application -ErrorAction SilentlyContinue).Source
    if (-not $node) {
        throw 'codex-hub: Node.js 22 or newer is required on PATH.'
    }
    $major = & $node -p "process.versions.node.split('.')[0]"
    if ($LASTEXITCODE -ne 0 -or [int]$major -lt 22) {
        throw 'codex-hub: Node.js 22 or newer is required on PATH.'
    }
    if ($CodexHubAction -eq 'install' -and -not (Get-Command codex -CommandType Application -ErrorAction SilentlyContinue)) {
        throw 'codex-hub: Codex CLI is required on PATH.'
    }
    if (-not (Get-Command Expand-Archive -ErrorAction SilentlyContinue)) {
        throw 'codex-hub: Expand-Archive is required.'
    }

    $tempDir = Join-Path ([IO.Path]::GetTempPath()) ('codex-hub-' + [guid]::NewGuid().ToString('N'))
    [IO.Directory]::CreateDirectory($tempDir) | Out-Null
    try {
        $archive = Join-Path $tempDir 'codex-hub.zip'
        $package = Join-Path $tempDir 'package'
        $releaseUrl = 'https://github.com/yuwenlong/codex-hub/releases/latest/download/codex-hub.zip'
        Invoke-WebRequest -UseBasicParsing -Uri $releaseUrl -OutFile $archive
        Expand-Archive -LiteralPath $archive -DestinationPath $package
        $manager = Join-Path $package 'codex-hub/scripts/manage.mjs'
        if (-not (Test-Path -LiteralPath $manager -PathType Leaf)) {
            throw 'codex-hub: The release ZIP does not contain the installer.'
        }
        & $node $manager $CodexHubAction
        if ($LASTEXITCODE -ne 0) {
            throw "codex-hub: $CodexHubAction failed (exit code $LASTEXITCODE)."
        }
    } finally {
        Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}
