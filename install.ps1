[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Email,
    [string]$Domain = 'localhost',
    [string]$Distribution,
    [string]$Directory,
    [ValidateSet('auto', 'plain', 'quiet')][string]$Progress = 'auto',
    [switch]$NoHttps,
    [switch]$NoDependencies,
    [switch]$SkipCron,
    [switch]$SystemInstall,
    [switch]$Check
)
$ErrorActionPreference = 'Stop'
if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
    throw 'Install WSL2 and a Linux distribution, then enable Docker Desktop WSL integration or install Docker inside that distribution.'
}
$wslOptions = @()
if ($Distribution) { $wslOptions += @('--distribution', $Distribution) }
Write-Progress -Activity 'NorthBot installation' -Status 'Checking WSL and locating source' -PercentComplete 0
$linuxSource = & wsl.exe @wslOptions --exec wslpath -a $PSScriptRoot
if ($LASTEXITCODE -ne 0 -or -not $linuxSource) {
    throw 'Start a WSL2 Linux distribution and enable Docker integration before retrying.'
}
$linuxSource = ($linuxSource -join "`n").Trim()
if ($Directory -and -not $Directory.StartsWith('/')) { throw '-Directory must be a Linux absolute path inside WSL.' }
$installerArgs = @('--exec', 'bash', "$linuxSource/install.sh", '--source', $linuxSource, '--email', $Email, '--domain', $Domain, '--progress', $Progress)
if (-not $SystemInstall) { $installerArgs += '--user' }
if ($Directory) { $installerArgs += @('--dir', $Directory) }
if ($NoHttps) { $installerArgs += '--no-https' }
if ($NoDependencies) { $installerArgs += '--no-deps' }
if ($SkipCron) { $installerArgs += '--skip-cron' }
if ($Check) { $installerArgs += '--check' }
Write-Progress -Activity 'NorthBot installation' -Completed
Write-Host 'Starting the WSL installer. Package, transfer, build and readiness progress follows.'
& wsl.exe @wslOptions @installerArgs
if ($LASTEXITCODE -ne 0) { throw "Installation stopped (exit $LASTEXITCODE); review the last failed stage above." }
