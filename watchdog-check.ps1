# Watchdog periódico de Flows Scan (zelva-agent).
# Se ejecuta cada pocos minutos vía Task Scheduler (ZelvaAgentWatchdog).
# A diferencia de start-agent.ps1 (que solo reacciona si el proceso muere),
# este chequea el síntoma real que nos mordió: el proceso sigue vivo pero
# el túnel de Cloudflare quedó sordo (URL registrada en el backend deja de
# resolver/responder, típicamente tras suspender/reanudar el PC o cambiar
# de red). En ese caso Node nunca dispara su handler 'exit' y nadie reinicia
# nada — este watchdog es quien lo detecta y fuerza el reinicio.

$ErrorActionPreference = 'Continue'
Set-Location -Path $PSScriptRoot

$logFile = Join-Path $PSScriptRoot 'watchdog.log'
$backendUrl = 'https://zalvaje-backend.onrender.com'

function Write-Log($msg) {
    $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Add-Content -Path $logFile -Value "[$ts] $msg"
}

function Test-AgentHealthy {
    # 1) ¿Hay algo escuchando en el puerto 3002?
    $listening = Get-NetTCPConnection -LocalPort 3002 -State Listen -ErrorAction SilentlyContinue
    if (-not $listening) {
        Write-Log 'Puerto 3002 no tiene listener.'
        return $false
    }

    # 2) ¿La URL pública registrada en el backend responde?
    try {
        $reg = Invoke-RestMethod -Uri "$backendUrl/api/agent/current-url" -TimeoutSec 10
        if (-not $reg.success -or -not $reg.url) {
            Write-Log 'Backend no devolvió una URL registrada.'
            return $false
        }
        try {
            Invoke-WebRequest -Uri $reg.url -TimeoutSec 10 -UseBasicParsing -ErrorAction Stop | Out-Null
            return $true
        } catch {
            # 401 "unauthorized" del agente cuenta como vivo — solo nos importa que responda.
            if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -gt 0) {
                return $true
            }
            Write-Log "Tunel registrado ($($reg.url)) no responde: $_"
            return $false
        }
    } catch {
        Write-Log "No se pudo consultar current-url en el backend: $_"
        # Si el backend mismo está caído, no reiniciamos el agente local — no es su culpa.
        return $true
    }
}

if (Test-AgentHealthy) {
    exit 0
}

Write-Log '⚠ Agente no saludable — reiniciando...'

Stop-ScheduledTask -TaskName 'ZelvaAgentAutoStart' -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='cloudflared.exe'" |
    Where-Object { $_.CommandLine -like '*zelva-agent*' -or $_.CommandLine -like '*localhost:3002*' } |
    ForEach-Object {
        Write-Log "Matando proceso huerfano PID $($_.ProcessId): $($_.CommandLine)"
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }

Start-Sleep -Seconds 2
Start-ScheduledTask -TaskName 'ZelvaAgentAutoStart'
Write-Log 'Reinicio disparado.'
