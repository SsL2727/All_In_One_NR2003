// NR2003 crash catcher: attaches to the game as a debugger (it does not change the game) and writes down exactly how it ended:
// the exception (code, where, in which module) or the exit code, a short stack of return addresses with module + offset, the
// last exceptions before it, and a small minidump. A FREEZE is caught too: when the game's window stops responding for HangSeconds in a
// row, every thread's stack and a minidump are written while it is stuck (the game keeps running; watching goes on).
// It watches any of the game's exe names (NR2003.exe and RaceLab's builds, NR2003_MS.exe / NR2003_RaceLabV2.exe).
// C# 5 (Windows PowerShell's Add-Type compiler).
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class CrashCatch
{
    [StructLayout(LayoutKind.Sequential)]
    struct DEBUG_EVENT { public uint code; public uint pid; public uint tid; public uint pad; [MarshalAs(UnmanagedType.ByValArray, SizeConst = 160)] public byte[] u; }

    [DllImport("kernel32.dll", SetLastError = true)] static extern bool DebugActiveProcess(uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool DebugActiveProcessStop(uint pid);
    [DllImport("kernel32.dll")] static extern bool DebugSetProcessKillOnExit(bool kill);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool WaitForDebugEvent(ref DEBUG_EVENT e, uint ms);
    [DllImport("kernel32.dll")] static extern bool ContinueDebugEvent(uint pid, uint tid, uint status);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] static extern IntPtr OpenThread(uint access, bool inherit, uint tid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, int n, out IntPtr read);
    [DllImport("kernel32.dll")] static extern bool Wow64GetThreadContext(IntPtr hThread, byte[] ctx);
    [DllImport("kernel32.dll")] static extern bool IsWow64Process(IntPtr h, out bool wow);
    [DllImport("psapi.dll", SetLastError = true)] static extern bool EnumProcessModulesEx(IntPtr h, IntPtr[] mods, int cb, out int needed, uint filter);
    [DllImport("psapi.dll", CharSet = CharSet.Unicode)] static extern uint GetModuleFileNameEx(IntPtr h, IntPtr mod, StringBuilder sb, int n);
    [DllImport("psapi.dll")] static extern bool GetModuleInformation(IntPtr h, IntPtr mod, out MODULEINFO mi, int cb);
    [DllImport("dbghelp.dll", SetLastError = true)] static extern bool MiniDumpWriteDump(IntPtr hProcess, uint pid, IntPtr hFile, int type, IntPtr exc, IntPtr user, IntPtr cb);
    [StructLayout(LayoutKind.Sequential)] struct MODULEINFO { public IntPtr Base; public uint Size; public IntPtr Entry; }
    [DllImport("user32.dll")] static extern bool IsHungAppWindow(IntPtr hwnd);
    [DllImport("kernel32.dll")] static extern int Wow64SuspendThread(IntPtr hThread);
    [DllImport("kernel32.dll")] static extern int ResumeThread(IntPtr hThread);
    public static int HangSeconds = 8;

    const uint DBG_CONTINUE = 0x00010002, DBG_NOT_HANDLED = 0x80010001;
    const uint EXCEPTION = 1, CREATE_THREAD = 2, CREATE_PROCESS = 3, EXIT_THREAD = 4, EXIT_PROCESS = 5, LOAD_DLL = 6, UNLOAD_DLL = 7, OUTPUT_STRING = 8;

    static string OutDir;
    static StringBuilder Log = new StringBuilder();
    static Queue<string> Recent = new Queue<string>();
    static string Name(uint code)
    {
        switch (code)
        {
            case 0xC0000005: return "ACCESS_VIOLATION";
            case 0xC00000FD: return "STACK_OVERFLOW";
            case 0xC0000094: return "INT_DIVIDE_BY_ZERO";
            case 0xC000001D: return "ILLEGAL_INSTRUCTION";
            case 0xC0000096: return "PRIV_INSTRUCTION";
            case 0xC0000374: return "HEAP_CORRUPTION";
            case 0xC0000409: return "STACK_BUFFER_OVERRUN / fail-fast";
            case 0xE06D7363: return "C++ exception";
            case 0x80000003: return "breakpoint";
            case 0x4000001F: return "wow64 breakpoint";
            case 0x406D1388: return "thread name";
            case 0xC0000008: return "INVALID_HANDLE";
            case 0xC000008C: return "ARRAY_BOUNDS";
            case 0xC0000025: return "NONCONTINUABLE";
            case 0xC000008E: return "FLT_DIVIDE_BY_ZERO";
            case 0xC0000090: return "FLT_INVALID_OPERATION";
            case 0xC0000006: return "IN_PAGE_ERROR";
            case 0xC0000017: return "NO_MEMORY";
        }
        return "";
    }

    static void Say(string s)
    {
        string line = DateTime.Now.ToString("HH:mm:ss.fff") + "  " + s;
        Log.AppendLine(line);
        Console.WriteLine(line);
    }

    static List<KeyValuePair<long, string>> Modules(IntPtr hp, out List<long[]> ranges)
    {
        var list = new List<KeyValuePair<long, string>>(); ranges = new List<long[]>();
        try
        {
            var mods = new IntPtr[1024]; int need;
            if (!EnumProcessModulesEx(hp, mods, mods.Length * IntPtr.Size, out need, 3)) return list;
            int n = Math.Min(mods.Length, need / IntPtr.Size);
            for (int i = 0; i < n; i++)
            {
                var sb = new StringBuilder(260); GetModuleFileNameEx(hp, mods[i], sb, 260);
                MODULEINFO mi; GetModuleInformation(hp, mods[i], out mi, Marshal.SizeOf(typeof(MODULEINFO)));
                long b = mi.Base.ToInt64();
                list.Add(new KeyValuePair<long, string>(b, Path.GetFileName(sb.ToString())));
                ranges.Add(new long[] { b, b + mi.Size });
            }
        }
        catch (Exception) { }
        return list;
    }

    static string Where(long addr, List<KeyValuePair<long, string>> mods, List<long[]> ranges)
    {
        for (int i = 0; i < ranges.Count; i++)
            if (addr >= ranges[i][0] && addr < ranges[i][1]) return mods[i].Value + "+0x" + (addr - ranges[i][0]).ToString("X");
        return "";
    }

    // registers + a short stack of one thread (32-bit game: WOW64 context)
    // suspend: a running thread (a freeze) is paused while its registers and stack are read, then let go
    static void ThreadStack(IntPtr hp, uint tid, List<KeyValuePair<long, string>> mods, List<long[]> ranges, int maxFrames, bool suspend)
    {
        IntPtr ht = OpenThread(0x0008 | 0x0040 | 0x0002, false, tid);
        if (ht != IntPtr.Zero)
        {
            bool paused = suspend && Wow64SuspendThread(ht) != -1;
            try {
            var ctx = new byte[716]; BitConverter.GetBytes(0x10007).CopyTo(ctx, 0);
            if (Wow64GetThreadContext(ht, ctx))
            {
                uint eip = BitConverter.ToUInt32(ctx, 0xB8), esp = BitConverter.ToUInt32(ctx, 0xC4), ebp = BitConverter.ToUInt32(ctx, 0xB4);
                Say("EIP=" + eip.ToString("X8") + " " + Where(eip, mods, ranges) + "  ESP=" + esp.ToString("X8") + "  EBP=" + ebp.ToString("X8") +
                    "  EAX=" + BitConverter.ToUInt32(ctx, 0xB0).ToString("X8") + " EBX=" + BitConverter.ToUInt32(ctx, 0xA4).ToString("X8") + " ECX=" + BitConverter.ToUInt32(ctx, 0xAC).ToString("X8") +
                    " EDX=" + BitConverter.ToUInt32(ctx, 0xA8).ToString("X8") + " ESI=" + BitConverter.ToUInt32(ctx, 0xA0).ToString("X8") + " EDI=" + BitConverter.ToUInt32(ctx, 0x9C).ToString("X8"));
                var stack = new byte[4 * 600]; IntPtr rd;
                if (ReadProcessMemory(hp, (IntPtr)esp, stack, stack.Length, out rd))
                {
                    int shown = 0;
                    for (int i = 0; i + 4 <= rd.ToInt32() && shown < maxFrames; i += 4)
                    {
                        long v = BitConverter.ToUInt32(stack, i); string w = Where(v, mods, ranges);
                        if (w != "") { Say("  stack[" + (i / 4) + "] " + v.ToString("X8") + "  " + w); shown++; }
                    }
                }
            }
            else Say("(no thread context: " + Marshal.GetLastWin32Error() + ")");
            } finally { if (paused) ResumeThread(ht); }
            CloseHandle(ht);
        }
    }

    static void Report(IntPtr hp, uint pid, uint tid, string why) { Report(hp, pid, tid, why, null, ""); }
    // allThreads: a freeze - every thread's stack (which one waits on what); tag goes in the file names
    static void Report(IntPtr hp, uint pid, uint tid, string why, Process allThreads, string tag)
    {
        Say("=== " + why);
        List<long[]> ranges; var mods = Modules(hp, out ranges);
        if (allThreads == null) ThreadStack(hp, tid, mods, ranges, 40, false);
        else
        {
            try { allThreads.Refresh(); } catch (Exception) { }
            foreach (ProcessThread th in allThreads.Threads)
            {
                string state = "";
                try { state = th.ThreadState.ToString() + (th.ThreadState == System.Diagnostics.ThreadState.Wait ? " (" + th.WaitReason + ")" : ""); } catch (Exception) { }
                Say("--- thread " + th.Id + " " + state);
                ThreadStack(hp, (uint)th.Id, mods, ranges, 24, true);
            }
        }
        Say("last exceptions before it (oldest first):");
        foreach (string r in Recent) Say("  " + r);
        Say("modules: " + string.Join(", ", mods.ConvertAll<string>(delegate(KeyValuePair<long, string> k) { return k.Value; }).ToArray()));
        string stamp = DateTime.Now.ToString("yyyyMMdd-HHmmss") + tag;
        try
        {
            string dmp = Path.Combine(OutDir, "nr2003-" + stamp + ".dmp");
            using (var fs = new FileStream(dmp, FileMode.Create))
            {
                bool ok = MiniDumpWriteDump(hp, pid, fs.SafeFileHandle.DangerousGetHandle(), 0x1 | 0x20 | 0x40 | 0x800 | 0x1000 | 0x2000, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);   // module data (globals) + unloaded modules + indirectly referenced memory + memory info + thread info + code
                Say("minidump " + (ok ? "written: " : "FAILED: ") + dmp);
            }
        }
        catch (Exception e) { Say("minidump failed: " + e.Message); }
        File.WriteAllText(Path.Combine(OutDir, "nr2003-" + stamp + ".txt"), Log.ToString());
        Say("report: " + Path.Combine(OutDir, "nr2003-" + stamp + ".txt"));
    }

    // watch one process until it ends
    static void Watch(Process p)
    {
        uint pid = (uint)p.Id;
        Log.Clear(); Recent.Clear();
        Say("attaching to " + p.ProcessName + " pid " + pid);
        IntPtr hp = OpenProcess(0x1F0FFF, false, pid);
        if (hp == IntPtr.Zero) { Say("cannot open the process (run as administrator, like the game)"); return; }
        if (!DebugActiveProcess(pid)) { Say("DebugActiveProcess failed: " + Marshal.GetLastWin32Error() + " (another debugger? run as administrator)"); CloseHandle(hp); return; }
        DebugSetProcessKillOnExit(false);
        Say("attached; the game runs as normal - leave this window open");
        int firstChance = 0; bool reported = false;
        DateTime hungSince = DateTime.MinValue; bool hangReported = false;
        var ev = new DEBUG_EVENT { u = new byte[160] };
        while (true)
        {
            if (!WaitForDebugEvent(ref ev, 1000))
            {
                if (p.HasExited) break;
                // a freeze: the game's window has not answered Windows for HangSeconds in a row - write it down once while it is stuck
                bool hung = false;
                try { p.Refresh(); IntPtr w = p.MainWindowHandle; hung = w != IntPtr.Zero && IsHungAppWindow(w); } catch (Exception) { }
                if (!hung) { if (hangReported) Say("the game is responding again"); hungSince = DateTime.MinValue; hangReported = false; continue; }
                if (hungSince == DateTime.MinValue) { hungSince = DateTime.Now; Say("the game window stopped responding..."); }
                if (!hangReported && (DateTime.Now - hungSince).TotalSeconds >= HangSeconds)
                {
                    hangReported = true;
                    Report(hp, pid, 0, "FROZEN: the game window has not responded for " + HangSeconds + " s (every thread's stack below)", p, "-hang");
                    Say("still watching (the game is not touched)");
                }
                continue;
            }
            uint status = DBG_CONTINUE;
            if (ev.code == EXCEPTION)
            {
                uint code = BitConverter.ToUInt32(ev.u, 0);
                long addr = BitConverter.ToInt64(ev.u, 16);
                uint first = BitConverter.ToUInt32(ev.u, 152);
                bool isBreak = code == 0x80000003 || code == 0x4000001F || code == 0x80000004 || code == 0x4000001E;
                if (isBreak) status = DBG_CONTINUE;
                else
                {
                    status = DBG_NOT_HANDLED;
                    string extra = "";
                    if (code == 0xC0000005 || code == 0xC0000006) extra = " " + (BitConverter.ToInt64(ev.u, 32) == 0 ? "reading" : BitConverter.ToInt64(ev.u, 32) == 1 ? "writing" : "executing") + " 0x" + BitConverter.ToInt64(ev.u, 40).ToString("X");
                    List<long[]> rg; var md = Modules(hp, out rg);
                    string line = (first != 0 ? "first-chance " : "SECOND-CHANCE ") + "0x" + code.ToString("X8") + " " + Name(code) + " at 0x" + addr.ToString("X") + " " + Where(addr, md, rg) + extra + " (thread " + ev.tid + ")";
                    Recent.Enqueue(DateTime.Now.ToString("HH:mm:ss.fff") + " " + line); while (Recent.Count > 25) Recent.Dequeue();
                    if (first != 0) firstChance++;
                    if (first == 0 && !reported) { reported = true; Report(hp, pid, ev.tid, "UNHANDLED EXCEPTION: " + line); }
                }
            }
            else if (ev.code == EXIT_PROCESS)
            {
                uint exitCode = BitConverter.ToUInt32(ev.u, 0);
                if (!reported) { reported = true; Report(hp, pid, ev.tid, "PROCESS EXITED with code " + exitCode + " (0x" + exitCode.ToString("X") + ") after " + firstChance + " handled exceptions" + (exitCode == 0 ? " - a normal exit (or the game called ExitProcess itself)" : "")); }
                ContinueDebugEvent(ev.pid, ev.tid, DBG_CONTINUE);
                break;
            }
            else if (ev.code == OUTPUT_STRING)
            {
                try
                {
                    long ptr = BitConverter.ToInt64(ev.u, 0); ushort uni = BitConverter.ToUInt16(ev.u, 8), len = BitConverter.ToUInt16(ev.u, 10);
                    var buf = new byte[Math.Max(0, Math.Min((int)len * (uni != 0 ? 2 : 1), 400))]; IntPtr rd;
                    if (buf.Length > 0 && ReadProcessMemory(hp, (IntPtr)ptr, buf, buf.Length, out rd))
                    {
                        string s = (uni != 0 ? Encoding.Unicode.GetString(buf) : Encoding.Default.GetString(buf)).Trim('\0', '\r', '\n', ' ');
                        if (s.Length > 0) { Recent.Enqueue(DateTime.Now.ToString("HH:mm:ss.fff") + " OutputDebugString: " + s); while (Recent.Count > 25) Recent.Dequeue(); }
                    }
                }
                catch (Exception) { }
            }
            ContinueDebugEvent(ev.pid, ev.tid, status);
        }
        try { DebugActiveProcessStop(pid); } catch (Exception) { }
        CloseHandle(hp);
    }

    // wait for the game, watch it, repeat
    // processNames: one or more exe names without .exe, comma separated (NR2003,NR2003_MS,NR2003_RaceLabV2)
    public static void Run(string processNames, string outDir, int maxRuns, int hangSeconds)
    {
        OutDir = outDir; Directory.CreateDirectory(outDir);
        if (hangSeconds > 0) HangSeconds = hangSeconds;
        var names = new List<string>();
        foreach (string n in processNames.Split(','))
        {
            string s = n.Trim(); if (s.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) s = s.Substring(0, s.Length - 4);
            if (s.Length > 0) names.Add(s);
        }
        Console.WriteLine("Waiting for " + string.Join(".exe / ", names.ToArray()) + ".exe ...  (reports go to " + outDir + "; a freeze is written down after " + HangSeconds + " s)");
        int runs = 0;
        while (maxRuns <= 0 || runs < maxRuns)
        {
            Process found = null;
            foreach (string n in names) { Process[] ps = Process.GetProcessesByName(n); if (ps.Length > 0) { found = ps[0]; break; } }
            if (found == null) { Thread.Sleep(1000); continue; }
            Watch(found); runs++;
            Thread.Sleep(2000);
        }
    }
    public static void Run(string processName, string outDir, int maxRuns) { Run(processName, outDir, maxRuns, 0); }
}
