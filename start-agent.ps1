# Mantiene Flows Scan (zelva-agent) corriendo — reinicia solo si el proceso se cae.
# Se registra vía Task Scheduler para arrancar al iniciar sesión de Windows.

$ErrorActionPreference = 'Continue'
Set-Location -Path $PSScriptRoot

$logFile = Join-Path $PSScriptRoot 'agent-startup.log'

function Write-Log($msg) {
    $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Add-Content -Path $logFile -Value "[$ts] $msg"
}

Write-Log '=== Flows Scan launcher iniciado ==='

while ($true) {
    Write-Log 'Arrancando npm start (tsx server.ts)...'
    try {
        & npm start *>> $logFile
    } catch {
        Write-Log "Error lanzando el proceso: $_"
    }
    Write-Log 'El proceso terminó o se cayó — reintentando en 10s...'
    Start-Sleep -Seconds 10
}
