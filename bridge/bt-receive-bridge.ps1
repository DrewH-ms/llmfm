# Opens an AudioPlaybackConnection to an already-paired A2DP source; the sink lasts exactly as long as this process holds the connection, and pairing is the user's act, never done here.

param([int] $ParentPid = 0)

$ErrorActionPreference = 'Stop'

$null = [System.Reflection.Assembly]::Load('System.Runtime.WindowsRuntime, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089')
$null = [Windows.Media.Audio.AudioPlaybackConnection, Windows.Media, ContentType=WindowsRuntime]
$null = [Windows.Devices.Enumeration.DeviceInformation, Windows.Devices.Enumeration, ContentType=WindowsRuntime]

# WinRT results arrive as System.__ComObject, which PowerShell cannot cast to IAsyncOperation<T>; the reflected extension method is the only route to the task.
$script:asTaskOperation = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and
                   $_.GetParameters().Count -eq 1 -and
                   $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]

# Distinct from the Closed a connection reports after it has been opened and let go.
$UNCONNECTED_STATE = 'None'
$CLOSED_STATE = 'Closed'
$SUCCESS_STATUS = 'Success'
# Bounds how long a connection outlives the process that asked for it.
$OWNER_POLL_MS = 200
# A refused open is transient often enough that a single attempt is a coin toss, and it blocks about five seconds.
$OPEN_ATTEMPTS = 3
$OPEN_RETRY_MS = 1000
# How long a dropped link is left Closed before the chosen device is opened again.
$REOPEN_INTERVAL_MS = 10000

$script:devices = $null
$script:connection = $null
$script:connectedId = ''
$script:connectedName = ''
$script:sinceReopen = [System.Diagnostics.Stopwatch]::StartNew()

function Write-Line([string] $line) {
    [Console]::Out.WriteLine($line)
    [Console]::Out.Flush()
}

function Wait-Operation($operation, [type] $resultType) {
    $task = $script:asTaskOperation.MakeGenericMethod($resultType).Invoke($null, @($operation))
    return $task.GetAwaiter().GetResult()
}

# Re-read on every listing, because pairing and radio state change under a running process.
function Update-Devices() {
    $selector = [Windows.Media.Audio.AudioPlaybackConnection]::GetDeviceSelector()
    $script:devices = Wait-Operation ([Windows.Devices.Enumeration.DeviceInformation]::FindAllAsync($selector)) ([Windows.Devices.Enumeration.DeviceInformationCollection])
    return $script:devices.Count
}

# State is system-wide per device rather than per object, so a device we hold nothing for is reported Closed from our own record.
function Format-State() {
    if ($script:connectedId -eq '') { return ('S ' + $UNCONNECTED_STATE + ' - -') }
    $state = $CLOSED_STATE
    if ($null -ne $script:connection) { $state = $script:connection.State.ToString() }
    return ('S ' + $state + ' ' + $script:connectedId + ' ' + $script:connectedName)
}

# An out-of-range device fails every call, and a close that cannot reach it must not take down the exit path that called it.
function Close-Link() {
    if ($null -eq $script:connection) { return }
    try {
        $script:connection.Dispose()
    } catch {
    }
    # Reading State on a disposed connection faults the process.
    $script:connection = $null
}

function Clear-Choice() {
    Close-Link
    $script:connectedId = ''
    $script:connectedName = ''
}

# Accepts either the index from the last listing or a device id, so a caller that knows the device need not enumerate.
function Resolve-Device([string] $reference) {
    if ($null -eq $script:devices) { Update-Devices | Out-Null }
    if ($reference -match '^[0-9]+$') {
        $index = [int] $reference
        if ($index -lt 0 -or $index -ge $script:devices.Count) { return $null }
        return $script:devices[$index]
    }
    foreach ($device in $script:devices) {
        if ($device.Id -eq $reference) { return $device }
    }
    return $null
}

# Retried because the first attempt fails transiently often enough to strand the feature; returns '' once open, the failure otherwise.
function Open-Link($connection, [int] $attempts) {
    $failure = ''
    for ($attempt = 0; $attempt -lt $attempts; $attempt++) {
        if ($attempt -gt 0) { Start-Sleep -Milliseconds $OPEN_RETRY_MS }
        $result = $connection.Open()
        if ($result.Status.ToString() -eq $SUCCESS_STATUS) { return '' }
        # A radio that is off reports UnknownFailure and identifies itself only in the extended error.
        $failure = $result.Status.ToString()
        if ($null -ne $result.ExtendedError) {
            $failure = $failure + ' 0x' + $result.ExtendedError.HResult.ToString('X8')
        }
    }
    return $failure
}

# A device that cannot be opened stays chosen so the read loop keeps trying; returns '' once open, the failure otherwise.
function Connect-Device([string] $id, [string] $name, [int] $attempts) {
    $connection = $null
    # Documented to return null for a device that cannot stream audio; the PowerShell projection throws an unhelpful cast error instead.
    try {
        $connection = [Windows.Media.Audio.AudioPlaybackConnection]::TryCreateFromId($id)
    } catch {
        return 'device does not offer a playback connection'
    }
    if ($null -eq $connection) { return 'device does not offer a playback connection' }
    Close-Link
    $script:connectedId = $id
    $script:connectedName = $name
    $script:sinceReopen.Restart()
    $connection.Start()
    $failure = Open-Link $connection $attempts
    if ($failure -ne '') {
        $connection.Dispose()
        return ('open failed ' + $failure)
    }
    $script:connection = $connection
    $script:sinceReopen.Restart()
    return ''
}

# A connection open across a link outage stays Closed forever, so the chosen device is reopened from scratch; one attempt per interval keeps a waiting caller from queueing behind a retry run.
function Restore-Link() {
    if ($script:connectedId -eq '') { return }
    if ($null -ne $script:connection -and $script:connection.State.ToString() -ne $CLOSED_STATE) { return }
    if ($script:sinceReopen.ElapsedMilliseconds -lt $REOPEN_INTERVAL_MS) { return }
    $script:sinceReopen.Restart()
    try {
        Connect-Device $script:connectedId $script:connectedName 1 | Out-Null
    } catch {
    }
}

try {
    $count = Update-Devices
} catch {
    Write-Line ('ERR ' + $_.Exception.Message)
    exit 1
}
Write-Line ('OK ' + $count)

# Held open for the life of the process: HasExited on a handle we opened cannot be fooled by pid reuse.
$owner = $null
if ($ParentPid -ne 0) {
    try { $owner = [System.Diagnostics.Process]::GetProcessById($ParentPid) } catch { $owner = $null }
}
$stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput())

try {
    :read while ($true) {
        # A killed owner does not reliably close the pipe, so a blocking read would never notice it dying.
        $read = $stdin.ReadLineAsync()
        while (-not $read.Wait($OWNER_POLL_MS)) {
            if ($null -ne $owner -and $owner.HasExited) { break read }
            Restore-Link
        }
        $line = $read.Result
        if ($null -eq $line) { break }
        if ($line.Length -eq 0) { continue }
        $command = $line[0]
        $argument = ''
        if ($line.Length -gt 2) { $argument = $line.Substring(2).Trim() }

        if ($command -eq 'Q') { break }

        try {
            if ($command -eq 'L') {
                $count = Update-Devices
                for ($index = 0; $index -lt $count; $index++) {
                    $device = $script:devices[$index]
                    Write-Line ('D ' + $index + ' ' + $device.Id + ' ' + $device.Name)
                }
                Write-Line ('N ' + $count)
            } elseif ($command -eq 'C') {
                $device = Resolve-Device $argument
                if ($null -eq $device) {
                    Write-Line 'ERR no such device'
                } else {
                    $failure = Connect-Device $device.Id $device.Name $OPEN_ATTEMPTS
                    if ($failure -ne '') {
                        Write-Line ('ERR ' + $failure)
                    } else {
                        Write-Line (Format-State)
                    }
                }
            } elseif ($command -eq 'G') {
                Write-Line (Format-State)
            } elseif ($command -eq 'X') {
                Clear-Choice
                Write-Line (Format-State)
            } else {
                Write-Line 'ERR unknown command'
            }
        } catch {
            Write-Line ('ERR ' + $_.Exception.Message)
        }
    }
} finally {
    Close-Link
}
