# System volume bridge: reads commands on stdin and drives the default audio
# render endpoint through the Core Audio IAudioEndpointVolume COM interface, and
# individual playback sessions on it through IAudioSessionControl2.
#
# This is how LLMFM rides music the user already chose: it cannot pause someone
# else's stream, only change the level it plays at.
#
# The endpoint gate silences the whole device. When the caller knows which
# application is playing what we mean to gate, it names that session instead and
# only that stream goes quiet.
#
# The endpoint's level at startup is the baseline, and this process restores it
# from its own `finally` block, along with any session it still holds muted,
# including when the process that started it exits without saying so. Losing
# stdin is not enough on its own: a dead parent does not reliably close the pipe,
# and a blocking read then waits forever, so the owner is watched by handle
# instead.
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
#   M <match>           mute every live session whose display name contains
#                       <match>, matched case-insensitively
#   U <match>           unmute the same
#   E                   list the live sessions on the endpoint
#   Q                   quit
# Responses:
#   OK <scalar> <0|1> <deviceId>            once, at startup
#   V <scalar> <0|1> <baseline> <0|1> <deviceId>
#                                           current level and mute, then the
#                                           level and mute we would restore to,
#                                           then the endpoint they belong to
#   A <count>                               sessions the gate was applied to
#   P <processId> <name>                    one per live session, then N <count>
#   ERR <message>

param([int] $ParentPid = 0)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

[ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
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

// Declaration order is the vtable in every interface below, so a slot nothing calls is
// still load-bearing: removing one silently rebinds the methods after it.

[ComImport, Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ISimpleAudioVolume {
    int SetMasterVolume(float level, ref Guid eventContext);
    int GetMasterVolume(out float level);
    int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid eventContext);
    int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
}

[ComImport, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionControl2 {
    // IAudioSessionControl first: the derived interface extends its vtable.
    int GetState(out int state);
    int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string value, ref Guid eventContext);
    int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string path);
    int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string value, ref Guid eventContext);
    int GetGroupingParam(out Guid groupingParam);
    int SetGroupingParam(ref Guid grouping, ref Guid eventContext);
    int RegisterAudioSessionNotification(IntPtr newNotifications);
    int UnregisterAudioSessionNotification(IntPtr newNotifications);
    int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
    int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
    int GetProcessId(out uint processId);
    int IsSystemSoundsSession();
    int SetDuckingPreference([MarshalAs(UnmanagedType.Bool)] bool optOut);
}

[ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionEnumerator {
    int GetCount(out int count);
    // Hands back an IAudioSessionControl; the caller queries it for the rest.
    int GetSession(int index, [MarshalAs(UnmanagedType.IUnknown)] out object session);
}

[ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionManager2 {
    // IAudioSessionManager first, for the same reason as IAudioSessionControl2.
    int GetAudioSessionControl(IntPtr audioSessionGuid, int streamFlags, out IntPtr sessionControl);
    int GetSimpleAudioVolume(IntPtr audioSessionGuid, int streamFlags, out IntPtr audioVolume);
    int GetSessionEnumerator(out IAudioSessionEnumerator sessions);
    int RegisterSessionNotification(IntPtr sessionNotification);
    int UnregisterSessionNotification(IntPtr sessionNotification);
    int RegisterDuckNotification([MarshalAs(UnmanagedType.LPWStr)] string sessionId, IntPtr duckNotification);
    int UnregisterDuckNotification(IntPtr duckNotification);
}

[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
    int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object instance);
    int OpenPropertyStore(int stgmAccess, out IntPtr properties);
    int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    int GetState(out int state);
}

[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
}

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class MMDeviceEnumerator { }

public class LlmfmSystemVolume {
    const int RENDER = 0;
    const int CONSOLE = 0;
    const int CLSCTX_ALL = 23;
    const int SESSION_EXPIRED = 2;

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
        object volume;
        if (device.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out volume) != 0) return null;
        endpoint = (IAudioEndpointVolume)volume;
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

    // Sessions are enumerated fresh for every call: they come and go on their own, a
    // reconnecting device gets a new one, and a pointer kept from last time would gate
    // something that has already ended.
    static IAudioSessionEnumerator OpenSessions() {
        IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
        IMMDevice device;
        if (enumerator.GetDefaultAudioEndpoint(RENDER, CONSOLE, out device) != 0) return null;
        Guid iid = typeof(IAudioSessionManager2).GUID;
        object manager;
        if (device.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out manager) != 0) return null;
        IAudioSessionEnumerator sessions;
        if (((IAudioSessionManager2)manager).GetSessionEnumerator(out sessions) != 0) return null;
        return sessions;
    }

    // What the volume mixer shows for a session: its own display name, or the name of the
    // process behind it when it does not set one.
    static string Label(IAudioSessionControl2 session) {
        string name;
        if (session.GetDisplayName(out name) == 0 && !string.IsNullOrEmpty(name)) return name;
        uint pid;
        if (session.GetProcessId(out pid) != 0 || pid == 0) return "";
        try {
            return System.Diagnostics.Process.GetProcessById((int)pid).ProcessName;
        } catch {
            return "";
        }
    }

    // Live sessions only. An expired session is a leftover of a stream that has already
    // ended, and the mixer keeps showing several of them; gating one would look like
    // success while the stream we meant to reach played on.
    static IAudioSessionControl2 Live(IAudioSessionEnumerator sessions, int index) {
        object control;
        if (sessions.GetSession(index, out control) != 0) return null;
        IAudioSessionControl2 session = control as IAudioSessionControl2;
        if (session == null) return null;
        int state;
        if (session.GetState(out state) != 0 || state == SESSION_EXPIRED) {
            Marshal.ReleaseComObject(session);
            return null;
        }
        return session;
    }

    // "<processId> <label>" for every live session on the endpoint, so a gate that matched
    // nothing can say what was actually playing.
    public static string[] ListSessions() {
        var found = new System.Collections.Generic.List<string>();
        IAudioSessionEnumerator sessions = OpenSessions();
        if (sessions == null) return found.ToArray();
        int count;
        if (sessions.GetCount(out count) != 0) count = 0;
        for (int index = 0; index < count; index++) {
            IAudioSessionControl2 session = Live(sessions, index);
            if (session == null) continue;
            uint pid;
            if (session.GetProcessId(out pid) != 0) pid = 0;
            found.Add(pid.ToString() + " " + Label(session));
            Marshal.ReleaseComObject(session);
        }
        Marshal.ReleaseComObject(sessions);
        return found.ToArray();
    }

    // Every live match is acted on, not just the first: the same name can belong to more
    // than one live stream, and missing one leaves the gate half open.
    public static int SetSessionMute(string match, bool mute) {
        IAudioSessionEnumerator sessions = OpenSessions();
        if (sessions == null) return 0;
        int count;
        if (sessions.GetCount(out count) != 0) count = 0;
        int acted = 0;
        for (int index = 0; index < count; index++) {
            IAudioSessionControl2 session = Live(sessions, index);
            if (session == null) continue;
            string label = Label(session);
            if (label.IndexOf(match, StringComparison.OrdinalIgnoreCase) >= 0) {
                ISimpleAudioVolume volume = session as ISimpleAudioVolume;
                if (volume != null) {
                    if (volume.SetMute(mute, ref eventContext) == 0) acted++;
                    Marshal.ReleaseComObject(volume);
                }
            }
            Marshal.ReleaseComObject(session);
        }
        Marshal.ReleaseComObject(sessions);
        return acted;
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
# Every match we have muted and not yet unmuted. A session mute belongs to the audio
# service rather than to this process, so it is the one thing here that outlives us.
$script:mutedMatches = New-Object System.Collections.Generic.List[string]

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

# Best effort per match: an application that has gone away, or an endpoint that has, must
# not leave the rest of the user's audio muted behind it.
function Clear-SessionMutes() {
    foreach ($match in @($script:mutedMatches)) {
        try {
            [LlmfmSystemVolume]::SetSessionMute($match, $false) | Out-Null
        } catch {
        }
    }
    $script:mutedMatches.Clear()
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
            } elseif ($command -eq 'M' -or $command -eq 'U') {
                $match = $line.Substring(2)
                if ($match.Length -eq 0) {
                    Write-Line "ERR no session match given"
                } else {
                    $muting = $command -eq 'M'
                    $acted = [LlmfmSystemVolume]::SetSessionMute($match, $muting)
                    if ($muting) {
                        if ($acted -gt 0 -and -not $script:mutedMatches.Contains($match)) {
                            $script:mutedMatches.Add($match)
                        }
                    } else {
                        $script:mutedMatches.Remove($match) | Out-Null
                    }
                    Write-Line ('A ' + $acted)
                }
            } elseif ($command -eq 'E') {
                $sessions = [LlmfmSystemVolume]::ListSessions()
                foreach ($session in $sessions) { Write-Line ('P ' + $session) }
                Write-Line ('N ' + $sessions.Count)
            } else {
                Write-Line "ERR unknown command"
            }
        } catch {
            Write-Line ("ERR " + $_.Exception.Message)
        }
    }
} finally {
    try { Clear-SessionMutes } catch { }
    Restore-Baseline
}
