# System volume bridge: reads commands on stdin and drives the default audio
# render endpoint through the Core Audio IAudioEndpointVolume COM interface.
#
# This is how LLMFM rides music the user already chose: it cannot pause someone
# else's stream, only change the level it plays at.
#
# The endpoint's level at startup is the baseline, and this process restores it
# from its own `finally` block, including when the process that started it exits
# without saying so. Losing stdin is not enough on its own: a dead parent does
# not reliably close the pipe, and a blocking read then waits forever, so the
# owner is watched by handle instead.
#
# This cannot cover being killed itself, and on Windows a hard kill of the owner
# takes this process with it. The caller persists the baseline for that case.
#
# A level the user moved themselves is never overwritten: if the endpoint has
# drifted from what we last set, the user has taken it back, and their value
# becomes the new baseline rather than something to restore over.
#
# Arguments:
#   -ParentPid <int>    process to outlive; the level is restored when it exits
#
# Protocol (one command per line, one response line each):
#   G                   report the current level
#   S <scalar> <0|1>    set level (0..1) and mute
#   B <scalar> <0|1>    adopt an externally recorded baseline and restore to it,
#                       which is how a level left behind by a killed daemon is
#                       recovered on the next start
#   R                   restore the baseline and release the claim
#   Q                   quit
# Responses:
#   OK <scalar> <0|1> <deviceId>            once, at startup
#   V <scalar> <0|1> <baseline> <0|1> <deviceId>
#                                           current level and mute, then the
#                                           level and mute we would restore to,
#                                           then the endpoint they belong to
#   ERR <message>

param([int] $ParentPid = 0)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
    int RegisterControlChangeNotify(IntPtr pNotify);
    int UnregisterControlChangeNotify(IntPtr pNotify);
    int GetChannelCount(out uint count);
    int SetMasterVolumeLevel(float levelDb, ref Guid eventContext);
    int SetMasterVolumeLevelScalar(float level, ref Guid eventContext);
    int GetMasterVolumeLevel(out float levelDb);
    int GetMasterVolumeLevelScalar(out float level);
    int SetChannelVolumeLevel(uint channel, float levelDb, ref Guid eventContext);
    int SetChannelVolumeLevelScalar(uint channel, float level, ref Guid eventContext);
    int GetChannelVolumeLevel(uint channel, out float levelDb);
    int GetChannelVolumeLevelScalar(uint channel, out float level);
    int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid eventContext);
    int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
}

[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
    int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, out IAudioEndpointVolume endpointVolume);
    int OpenPropertyStore(int stgmAccess, out IntPtr properties);
    int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    int GetState(out int state);
}

[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
    // Declaration order is the vtable, so this slot is load-bearing even though nothing
    // calls it. Removing it would silently rebind the method below to the wrong function.
    int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
}

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class MMDeviceEnumerator { }

public class LlmfmSystemVolume {
    const int RENDER = 0;
    const int CONSOLE = 0;
    const int CLSCTX_ALL = 23;

    // Identifies our own changes in the endpoint's change notifications, so a
    // volume OSD or another listener can tell them from the user's.
    static Guid eventContext = new Guid("6f1b1f4e-9a6a-4d3e-9a0f-2b8a1c5d7e30");
    static IAudioEndpointVolume endpoint;
    static string deviceId;

    // The endpoint we are bound to, which is not necessarily the current default: the
    // device we must restore is the one we actually changed.
    public static string DeviceId { get { return deviceId; } }

    // Which endpoint the user is listening to right now, without binding it.
    public static string DefaultId() {
        IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
        IMMDevice device;
        if (enumerator.GetDefaultAudioEndpoint(RENDER, CONSOLE, out device) != 0) return null;
        string id;
        if (device.GetId(out id) != 0) return null;
        return id;
    }

    // Binds the current default, replacing any endpoint already held.
    public static string Open() {
        IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
        IMMDevice device;
        if (enumerator.GetDefaultAudioEndpoint(RENDER, CONSOLE, out device) != 0) return null;
        Guid iid = typeof(IAudioEndpointVolume).GUID;
        IAudioEndpointVolume volume;
        if (device.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out volume) != 0) return null;
        endpoint = volume;
        string id;
        if (device.GetId(out id) != 0) id = "unknown";
        deviceId = id;
        return id;
    }

    public static float GetLevel() {
        float level;
        if (endpoint.GetMasterVolumeLevelScalar(out level) != 0) throw new Exception("GetMasterVolumeLevelScalar failed");
        return level;
    }

    public static bool GetMute() {
        bool mute;
        if (endpoint.GetMute(out mute) != 0) throw new Exception("GetMute failed");
        return mute;
    }

    public static void SetLevel(float level) {
        if (level < 0f) level = 0f;
        if (level > 1f) level = 1f;
        if (endpoint.SetMasterVolumeLevelScalar(level, ref eventContext) != 0) throw new Exception("SetMasterVolumeLevelScalar failed");
    }

    public static void SetMute(bool mute) {
        if (endpoint.SetMute(mute, ref eventContext) != 0) throw new Exception("SetMute failed");
    }
}
'@

# Half a percentage point: below any manual step the volume keys or slider take,
# above the rounding of a scalar that survived a round trip through text.
$DRIFT_EPSILON = 0.005
$culture = [System.Globalization.CultureInfo]::InvariantCulture

$script:baselineLevel = 0.0
$script:baselineMute = $false
$script:heldLevel = 0.0
$script:heldMute = $false
$script:holding = $false

function Write-Line([string] $line) {
    [Console]::Out.WriteLine($line)
    [Console]::Out.Flush()
}

function Format-Level([float] $level, [bool] $mute) {
    $flag = 0
    if ($mute) { $flag = 1 }
    return ($level.ToString('F6', $culture) + ' ' + $flag)
}

# True when the endpoint still sits where we last put it. When it does not, the
# user has moved it and owns the level again.
function Test-Ours([float] $level, [bool] $mute) {
    if (-not $script:holding) { return $false }
    return ([math]::Abs($level - $script:heldLevel) -le $DRIFT_EPSILON) -and ($mute -eq $script:heldMute)
}

function Format-State() {
    $level = [LlmfmSystemVolume]::GetLevel()
    $mute = [LlmfmSystemVolume]::GetMute()
    return ('V ' + (Format-Level $level $mute) + ' ' + (Format-Level ([float] $script:baselineLevel) ([bool] $script:baselineMute)) + ' ' + [LlmfmSystemVolume]::DeviceId)
}

# An endpoint can be unplugged out from under us, and every call on it then fails. The
# caller learns that from the reading it asked for; a restore that cannot reach its device
# must not take down the exit path that called it.
function Restore-Baseline() {
    if (-not $script:holding) { return }
    try {
        $level = [LlmfmSystemVolume]::GetLevel()
        $mute = [LlmfmSystemVolume]::GetMute()
        if (Test-Ours $level $mute) {
            [LlmfmSystemVolume]::SetLevel([float] $script:baselineLevel)
            if ($mute -ne $script:baselineMute) { [LlmfmSystemVolume]::SetMute([bool] $script:baselineMute) }
        }
    } catch {
    }
    $script:holding = $false
}

# The gate has to land on the device the user is actually listening to. A headset plugged
# in mid-session moves the default, and a mute left behind on the endpoint we bound at
# startup would be silence nobody hears and a flag nobody clears. At most one endpoint is
# ever held, and the one we give up is put back before we let go of it. Releasing it also
# clears the hold, so the caller adopts the new device's state as the baseline.
function Sync-Endpoint() {
    $current = [LlmfmSystemVolume]::DefaultId()
    if (-not $current -or $current -eq [LlmfmSystemVolume]::DeviceId) { return }
    Restore-Baseline
    [LlmfmSystemVolume]::Open() | Out-Null
}

try {
    $deviceId = [LlmfmSystemVolume]::Open()
} catch {
    Write-Line ("ERR " + $_.Exception.Message)
    exit 1
}
if (-not $deviceId) {
    Write-Line "ERR no default audio render endpoint"
    exit 1
}

$script:baselineLevel = [LlmfmSystemVolume]::GetLevel()
$script:baselineMute = [LlmfmSystemVolume]::GetMute()
Write-Line ("OK " + (Format-Level $script:baselineLevel $script:baselineMute) + " " + $deviceId)

# Held open for the life of the process: HasExited on a handle we opened cannot
# be fooled by the pid being reused.
$owner = $null
if ($ParentPid -ne 0) {
    try { $owner = [System.Diagnostics.Process]::GetProcessById($ParentPid) } catch { $owner = $null }
}
# Bounds how long a level outlives the process that asked for it.
$OWNER_POLL_MS = 200
$stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput())

try {
    :read while ($true) {
        # A blocking read would never notice the owner dying, and a killed owner
        # does not reliably close the pipe, so the read has to be waitable.
        $read = $stdin.ReadLineAsync()
        while (-not $read.Wait($OWNER_POLL_MS)) {
            if ($null -ne $owner -and $owner.HasExited) { break read }
        }
        $line = $read.Result
        if ($null -eq $line) { break }
        if ($line.Length -eq 0) { continue }
        $command = $line[0]

        if ($command -eq 'Q') { break }

        try {
            if ($command -eq 'G') {
                Write-Line (Format-State)
            } elseif ($command -eq 'S') {
                Sync-Endpoint
                $parts = $line.Substring(2).Split(' ')
                $target = [float]::Parse($parts[0], $culture)
                $targetMute = $parts[1] -eq '1'
                $level = [LlmfmSystemVolume]::GetLevel()
                $mute = [LlmfmSystemVolume]::GetMute()
                # A level the user moved themselves becomes what we owe them back.
                if (-not (Test-Ours $level $mute)) {
                    $script:baselineLevel = $level
                    $script:baselineMute = $mute
                }
                [LlmfmSystemVolume]::SetLevel($target)
                if ($targetMute -ne $mute) { [LlmfmSystemVolume]::SetMute($targetMute) }
                $script:heldLevel = [LlmfmSystemVolume]::GetLevel()
                $script:heldMute = [LlmfmSystemVolume]::GetMute()
                $script:holding = $true
                Write-Line (Format-State)
            } elseif ($command -eq 'B') {
                $parts = $line.Substring(2).Split(' ')
                $script:baselineLevel = [float]::Parse($parts[0], $culture)
                $script:baselineMute = $parts[1] -eq '1'
                $script:heldLevel = [LlmfmSystemVolume]::GetLevel()
                $script:heldMute = [LlmfmSystemVolume]::GetMute()
                $script:holding = $true
                Restore-Baseline
                Write-Line (Format-State)
            } elseif ($command -eq 'R') {
                Restore-Baseline
                Write-Line (Format-State)
            } else {
                Write-Line "ERR unknown command"
            }
        } catch {
            Write-Line ("ERR " + $_.Exception.Message)
        }
    }
} finally {
    Restore-Baseline
}
