# MIDI bridge: reads packed short messages on stdin, sends them to a Windows
# MIDI output device via winmm.
#
# Chrome's Web MIDI backend does not enumerate the Microsoft GS Wavetable Synth
# (notably on ARM64), even though winmm does. This bridge gives the daemon direct
# access to it. We only send MIDI messages to the OS synth -- gm.dls is never read,
# copied, or redistributed, which is what its Roland license requires.
#
# Protocol (one command per line):
#   S <int>   send packed short message (status | data1<<8 | data2<<16)
#   Q         quit
#
# Arguments:
#   -ParentPid <int>    process to outlive; the synth is reset and closed when it exits

param([int] $ParentPid = 0)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public class WinMidi {
    [DllImport("winmm.dll")] public static extern int midiOutGetNumDevs();
    [DllImport("winmm.dll")] public static extern int midiOutOpen(out IntPtr h, int deviceId, IntPtr cb, IntPtr inst, int flags);
    [DllImport("winmm.dll")] public static extern int midiOutShortMsg(IntPtr h, int msg);
    [DllImport("winmm.dll")] public static extern int midiOutReset(IntPtr h);
    [DllImport("winmm.dll")] public static extern int midiOutClose(IntPtr h);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct CAPS {
        public ushort mid; public ushort pid; public uint driverVersion;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string name;
        public ushort technology; public ushort voices; public ushort notes;
        public ushort channelMask; public uint support;
    }
    [DllImport("winmm.dll", CharSet = CharSet.Unicode)]
    public static extern int midiOutGetDevCapsW(IntPtr id, ref CAPS caps, int size);

    public static IntPtr Handle = IntPtr.Zero;

    // Prefers the Microsoft GS Wavetable Synth, which is present on stock Windows
    // and needs no hardware, falling back to the first device offered.
    public static string Open() {
        int n = midiOutGetNumDevs();
        if (n <= 0) return null;
        int pick = 0;
        string chosen = null;
        for (int i = 0; i < n; i++) {
            CAPS c = new CAPS();
            midiOutGetDevCapsW((IntPtr)i, ref c, Marshal.SizeOf(typeof(CAPS)));
            if (chosen == null) { chosen = c.name; pick = i; }
            if (c.name != null && c.name.ToLower().Contains("wavetable")) { chosen = c.name; pick = i; break; }
        }
        IntPtr h;
        if (midiOutOpen(out h, pick, IntPtr.Zero, IntPtr.Zero, 0) != 0) return null;
        Handle = h;
        return chosen;
    }

    public static void Send(int msg) { if (Handle != IntPtr.Zero) midiOutShortMsg(Handle, msg); }
    public static void Close() {
        if (Handle != IntPtr.Zero) { midiOutReset(Handle); midiOutClose(Handle); Handle = IntPtr.Zero; }
    }
}
'@

$name = [WinMidi]::Open()
if (-not $name) {
    [Console]::Out.WriteLine("ERR no midi output device")
    [Console]::Out.Flush()
    exit 1
}
[Console]::Out.WriteLine("OK $name")
[Console]::Out.Flush()

# Held open for the life of the process: HasExited on a handle we opened cannot be
# fooled by the pid being reused.
$owner = $null
if ($ParentPid -ne 0) {
    try { $owner = [System.Diagnostics.Process]::GetProcessById($ParentPid) } catch { $owner = $null }
}
# Bounds how long a note sounds after the process that played it is gone.
$OWNER_POLL_MS = 200
$stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput())

try {
    :read while ($true) {
        # A blocking read would never notice the owner dying, and a killed owner does
        # not reliably close the pipe, so the read has to be waitable.
        $read = $stdin.ReadLineAsync()
        while (-not $read.Wait($OWNER_POLL_MS)) {
            if ($null -ne $owner -and $owner.HasExited) { break read }
        }
        $line = $read.Result
        if ($null -eq $line) { break }
        if ($line.Length -eq 0) { continue }
        $c = $line[0]
        if ($c -eq 'S') {
            [WinMidi]::Send([int]$line.Substring(2))
        } elseif ($c -eq 'Q') {
            break
        }
    }
} finally {
    [WinMidi]::Close()
}
