# Bluetooth audio receive bridge: reads commands on stdin and opens an
# AudioPlaybackConnection to a paired A2DP source, so a phone can play into this
# machine's default render endpoint the same way a Bluetooth speaker plays out of it.
#
# This is how LLMFM hears the music the user already chose on their phone: the
# phone stays the transport, and Windows renders what it sends. Nothing here
# starts, stops, or reads the audio itself.
#
# The sink stays up for exactly as long as a process holds the connection, so this
# process is the resource. Letting it die is how the machine stops being a
# Bluetooth speaker, and the connection is disposed from this process's own
# `finally` block so a clean exit is as tidy as a kill. Losing stdin is not enough
# on its own: a dead parent does not reliably close the pipe, and a blocking read
# then waits forever, so the owner is watched by handle instead.
#
# A link that drops out of range leaves the connection Closed for good, so the
# device the caller chose is re-opened from the read loop rather than waited on.
#
# The device must already be paired in Windows Settings. Pairing is the user's
# act and is never performed here.
#
# Arguments:
#   -ParentPid <int>    process to outlive; the connection is closed when it exits
#
# Protocol (one command per line):
#   L                   list paired A2DP sources, one per line, then a count
#   C <index|id>        connect to a device and open its playback connection
#   G                   report the current connection state
#   X                   close the connection and keep running
#   Q                   quit
# Responses:
#   OK <count>                              once, at startup
#   D <index> <id> <name>                   one per device, in answer to L
#   N <count>                               terminates the listing
#   S <state> <id> <name>                   connection state, where state is
#                                           Closed, Opened, or None when nothing
#                                           is connected
#   ERR <message>

param([int] $ParentPid = 0)

$ErrorActionPreference = 'Stop'

$null = [System.Reflection.Assembly]::Load('System.Runtime.WindowsRuntime, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089')
$null = [Windows.Media.Audio.AudioPlaybackConnection, Windows.Media, ContentType=WindowsRuntime]
$null = [Windows.Devices.Enumeration.DeviceInformation, Windows.Devices.Enumeration, ContentType=WindowsRuntime]

# WinRT asynchronous results arrive as System.__ComObject, which PowerShell cannot
# cast to IAsyncOperation<T>; the extension method bound by reflection is the only
# route that reaches the underlying task.
$script:asTaskOperation = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and
                   $_.GetParameters().Count -eq 1 -and
                   $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]

# The state reported when no device is connected, distinct from the Closed a
# connection reports after it has been opened and let go.
$UNCONNECTED_STATE = 'None'
$CLOSED_STATE = 'Closed'
$SUCCESS_STATUS = 'Success'
# Bounds how long a connection outlives the process that asked for it.
$OWNER_POLL_MS = 200
# A refused open is transient often enough that a single attempt is a coin toss,
# and it blocks for about five seconds before it answers.
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

# The paired devices Windows is willing to accept audio from. Re-read on every
# listing, because pairing and radio state change under a running process.
function Update-Devices() {
    $selector = [Windows.Media.Audio.AudioPlaybackConnection]::GetDeviceSelector()
    $script:devices = Wait-Operation ([Windows.Devices.Enumeration.DeviceInformation]::FindAllAsync($selector)) ([Windows.Devices.Enumeration.DeviceInformationCollection])
    return $script:devices.Count
}

# State is system-wide per device rather than per object, so a chosen device we hold
# nothing for is reported as Closed on the strength of our own record, not the system's.
function Format-State() {
    if ($script:connectedId -eq '') { return ('S ' + $UNCONNECTED_STATE + ' - -') }
    $state = $CLOSED_STATE
    if ($null -ne $script:connection) { $state = $script:connection.State.ToString() }
    return ('S ' + $state + ' ' + $script:connectedId + ' ' + $script:connectedName)
}

# A connection whose device has gone out of range fails every call on it, and a
# close that cannot reach its device must not take down the exit path that called it.
# The device stays chosen: only the caller gives that up.
function Close-Link() {
    if ($null -eq $script:connection) { return }
    try {
        $script:connection.Dispose()
    } catch {
    }
    # Reading State on a disposed connection faults the process, so the reference
    # goes away with the object.
    $script:connection = $null
}

function Clear-Choice() {
    Close-Link
    $script:connectedId = ''
    $script:connectedName = ''
}

# Accepts either the index from the last listing or a device id, so a caller that
# already knows the device does not have to enumerate first.
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

# Success is reported by the radio and the phone together, and the first attempt
# fails transiently often enough that giving up on it would strand the feature.
# Returns an empty string once the link is open, the failure otherwise.
function Open-Link($connection, [int] $attempts) {
    $failure = ''
    for ($attempt = 0; $attempt -lt $attempts; $attempt++) {
        if ($attempt -gt 0) { Start-Sleep -Milliseconds $OPEN_RETRY_MS }
        $result = $connection.Open()
        if ($result.Status.ToString() -eq $SUCCESS_STATUS) { return '' }
        # Status alone does not name the failure: a radio that is off reports
        # UnknownFailure and identifies itself only in the extended error.
        $failure = $result.Status.ToString()
        if ($null -ne $result.ExtendedError) {
            $failure = $failure + ' 0x' + $result.ExtendedError.HResult.ToString('X8')
        }
    }
    return $failure
}

# At most one device is ever connected, and the one we give up is closed before we let
# go of it. A device that cannot be opened stays chosen so the read loop keeps trying.
# Returns an empty string once the link is open, the failure otherwise.
function Connect-Device([string] $id, [string] $name, [int] $attempts) {
    $connection = $null
    # Documented to return null for a device that cannot stream audio; the
    # PowerShell projection throws an unhelpful cast error instead.
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

# A connection that was open across a link outage stays Closed forever, and a phone that
# walked out of the room comes back, so the chosen device is opened again from scratch
# for as long as it is the choice. One attempt per interval: the interval is the retry,
# and a caller waiting on a state reply must not queue behind a whole retry run. Silent:
# the caller hears about it in the next state it asks for.
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

# Held open for the life of the process: HasExited on a handle we opened cannot
# be fooled by the pid being reused.
$owner = $null
if ($ParentPid -ne 0) {
    try { $owner = [System.Diagnostics.Process]::GetProcessById($ParentPid) } catch { $owner = $null }
}
$stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput())

try {
    :read while ($true) {
        # A blocking read would never notice the owner dying, and a killed owner
        # does not reliably close the pipe, so the read has to be waitable.
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
