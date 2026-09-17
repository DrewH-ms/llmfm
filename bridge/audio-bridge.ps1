# Plays .mp3/.wav through MCI (winmm). Every command carries a caller-supplied id echoed in the reply, so correlation is explicit rather than positional.

param([int] $ParentPid = 0)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public class LlmfmAudio {
    [DllImport("winmm.dll", CharSet = CharSet.Unicode)]
    public static extern int mciSendStringW(string cmd, StringBuilder ret, int retLen, IntPtr hwnd);

    [DllImport("winmm.dll", CharSet = CharSet.Unicode)]
    public static extern int mciGetErrorStringW(int error, StringBuilder ret, int retLen);

    public static string LastError = "";

    // Returns the device's reply, or null when MCI refused the command. The rc is
    // translated here because the numeric code alone tells the caller nothing.
    public static string Send(string cmd) {
        StringBuilder ret = new StringBuilder(512);
        int rc = mciSendStringW(cmd, ret, ret.Capacity, IntPtr.Zero);
        if (rc != 0) {
            StringBuilder err = new StringBuilder(512);
            if (mciGetErrorStringW(rc, err, err.Capacity) == 0) LastError = "mci error " + rc;
            else LastError = err.ToString();
            return null;
        }
        LastError = "";
        return ret.ToString();
    }
}
'@

function Write-Line([string] $line) {
    [Console]::Out.WriteLine($line)
    [Console]::Out.Flush()
}

$script:alias = $null
$script:aliasSeq = 0
# MCI volume is a property of the open device, not of the session, so it is reapplied on every open.
$script:volume = 1000

function Send-Mci([string] $command) {
    $result = [LlmfmAudio]::Send($command)
    if ($null -eq $result) { throw [LlmfmAudio]::LastError }
    return $result
}

function Close-Current() {
    if ($null -eq $script:alias) { return }
    # Best effort: a device that already died would otherwise block every later open.
    [LlmfmAudio]::Send('stop ' + $script:alias) | Out-Null
    [LlmfmAudio]::Send('close ' + $script:alias) | Out-Null
    $script:alias = $null
}

function Require-Alias() {
    if ($null -eq $script:alias) { throw 'no file open' }
    return $script:alias
}

function Open-File([string] $path) {
    Close-Current
    $script:aliasSeq++
    $name = 'llmfm' + $script:aliasSeq
    # mpegvideo handles .mp3 and most .wav; some wave files need the dedicated waveaudio device, so it is the fallback.
    $type = 'mpegvideo'
    $opened = [LlmfmAudio]::Send('open "' + $path + '" type mpegvideo alias ' + $name)
    if ($null -eq $opened) {
        $first = [LlmfmAudio]::LastError
        $type = 'waveaudio'
        $opened = [LlmfmAudio]::Send('open "' + $path + '" type waveaudio alias ' + $name)
        if ($null -eq $opened) { throw ($first + ' / ' + [LlmfmAudio]::LastError) }
    }
    $script:alias = $name
    Send-Mci ('setaudio ' + $name + ' volume to ' + $script:volume) | Out-Null
    $length = Send-Mci ('status ' + $name + ' length')
    return ($length.Trim() + ' ' + $type)
}

function Invoke-Command-Line([string] $verb, [string] $argument) {
    switch ($verb) {
        'OPEN'     { return Open-File $argument }
        'PLAY'     { Send-Mci ('play ' + (Require-Alias)) | Out-Null; return '' }
        'PAUSE'    { Send-Mci ('pause ' + (Require-Alias)) | Out-Null; return '' }
        'RESUME'   { Send-Mci ('resume ' + (Require-Alias)) | Out-Null; return '' }
        'STOP'     { Send-Mci ('stop ' + (Require-Alias)) | Out-Null; return '' }
        'SEEK'     { Send-Mci ('seek ' + (Require-Alias) + ' to ' + [int] $argument) | Out-Null; return '' }
        'POSITION' { return (Send-Mci ('status ' + (Require-Alias) + ' position')).Trim() }
        'CLOSE'    { Close-Current; return '' }
        'VOLUME'   {
            $level = [int] $argument
            if ($level -lt 0) { $level = 0 }
            if ($level -gt 1000) { $level = 1000 }
            $script:volume = $level
            if ($null -ne $script:alias) {
                Send-Mci ('setaudio ' + $script:alias + ' volume to ' + $level) | Out-Null
            }
            return ''
        }
    }
    throw ('unknown command ' + $verb)
}

Write-Line 'OK ready'

# Held open for the life of the process: HasExited on a handle we opened cannot be fooled by pid reuse.
$owner = $null
if ($ParentPid -ne 0) {
    try { $owner = [System.Diagnostics.Process]::GetProcessById($ParentPid) } catch { $owner = $null }
}
# Bounds how long a track outlives the process that asked for it.
$OWNER_POLL_MS = 200
$stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput())

try {
    :read while ($true) {
        # A killed owner does not reliably close the pipe, so a blocking read would never notice it dying.
        $read = $stdin.ReadLineAsync()
        while (-not $read.Wait($OWNER_POLL_MS)) {
            if ($null -ne $owner -and $owner.HasExited) { break read }
        }
        $line = $read.Result
        if ($null -eq $line) { break }
        if ($line.Length -eq 0) { continue }

        $parts = $line.Trim().Split([char[]]' ', 3)
        $id = $parts[0]
        if ($parts.Length -lt 2) {
            Write-Line ($id + ' ERR missing verb')
            continue
        }
        $verb = $parts[1].ToUpperInvariant()
        $argument = ''
        if ($parts.Length -gt 2) { $argument = $parts[2] }

        if ($verb -eq 'QUIT') {
            Write-Line ($id + ' OK')
            break
        }

        try {
            $payload = Invoke-Command-Line $verb $argument
            if ([string]::IsNullOrEmpty($payload)) { Write-Line ($id + ' OK') }
            else { Write-Line ($id + ' OK ' + $payload) }
        } catch {
            $message = $_.Exception.Message
            if ([string]::IsNullOrWhiteSpace($message)) { $message = 'command failed' }
            Write-Line ($id + ' ERR ' + ($message -replace '\s+', ' '))
        }
    }
} finally {
    # A leaked MCI device keeps sounding after the daemon is gone.
    Close-Current
}
