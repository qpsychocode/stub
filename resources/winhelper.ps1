# STUB Windows helper: persistent JSON-lines server (stdin -> stdout).
# Request:  {"id":1,"cmd":"detect|find|paste|pasteInto|pasteImage|listChats|openChat|atCursor|focus|ping", ...}
# Response: {"id":1,"ok":true, ...}
# Keep this file ASCII-only (Windows PowerShell 5.1 reads -File scripts as ANSI without BOM).

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase

$src = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;

public class WinInfo {
    public long Hwnd;
    public int Pid;
    public string Title;
    public string Proc;
}

public static class StubWin {
    delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
    [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
    [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] static extern int GetWindowLong32(IntPtr h, int idx);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr64(IntPtr h, int idx);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int val, int size);
    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);

    [StructLayout(LayoutKind.Sequential)]
    struct POINT { public int X; public int Y; }
    [StructLayout(LayoutKind.Sequential)]
    struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Explicit)]
    struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)]
    struct INPUT { public uint type; public InputUnion u; }

    const int GWL_EXSTYLE = -20;
    const long WS_EX_TOOLWINDOW = 0x80;
    const long WS_EX_APPWINDOW = 0x40000;
    const uint GW_OWNER = 4;
    const byte VK_MENU = 0x12;
    const byte VK_SHIFT = 0x10;
    const byte VK_ESCAPE = 0x1B;
    const byte VK_CONTROL = 0x11;
    const byte VK_RETURN = 0x0D;
    const byte VK_V = 0x56;
    const uint KEYEVENTF_KEYUP = 0x2;

    static long ExStyle(IntPtr h) {
        if (IntPtr.Size == 8) return GetWindowLongPtr64(h, GWL_EXSTYLE).ToInt64();
        return GetWindowLong32(h, GWL_EXSTYLE);
    }

    static string Title(IntPtr h) {
        int len = GetWindowTextLength(h);
        if (len <= 0) return "";
        var sb = new StringBuilder(len + 2);
        GetWindowText(h, sb, sb.Capacity);
        return sb.ToString();
    }

    /// Top-level, visible, titled, non-tool windows in z-order (topmost first).
    public static List<WinInfo> Windows() {
        var res = new List<WinInfo>();
        var procNames = new Dictionary<uint, string>();
        EnumWindows(delegate (IntPtr h, IntPtr l) {
            if (!IsWindowVisible(h)) return true;
            string t = Title(h);
            if (t.Length == 0) return true;
            long ex = ExStyle(h);
            bool tool = (ex & WS_EX_TOOLWINDOW) != 0 && (ex & WS_EX_APPWINDOW) == 0;
            if (tool) return true;
            if (GetWindow(h, GW_OWNER) != IntPtr.Zero && (ex & WS_EX_APPWINDOW) == 0) return true;
            int cloaked;
            // DWM_CLOAKED_APP (1) = hidden by its own app (e.g. suspended UWP host); shell-cloaked (other desktop) is kept.
            if (DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && (cloaked & 1) != 0) return true;
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            string pn;
            if (!procNames.TryGetValue(pid, out pn)) {
                try { pn = Process.GetProcessById((int)pid).ProcessName; } catch { pn = ""; }
                procNames[pid] = pn;
            }
            res.Add(new WinInfo { Hwnd = h.ToInt64(), Pid = (int)pid, Title = t, Proc = pn });
            return true;
        }, IntPtr.Zero);
        return res;
    }

    /// Top-level window under the mouse cursor. Cursor and hit-test run in this process, so DPI scaling cannot skew them.
    public static WinInfo AtCursor() {
        POINT p;
        if (!GetCursorPos(out p)) return null;
        IntPtr h = WindowFromPoint(p);
        if (h == IntPtr.Zero) return null;
        h = GetAncestor(h, 2); // GA_ROOT
        if (h == IntPtr.Zero) return null;
        uint pid;
        GetWindowThreadProcessId(h, out pid);
        string pn;
        try { pn = Process.GetProcessById((int)pid).ProcessName; } catch { pn = ""; }
        return new WinInfo { Hwnd = h.ToInt64(), Pid = (int)pid, Title = Title(h), Proc = pn };
    }

    static string Strip(string n) {
        n = (n ?? "").Trim();
        if (n.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) n = n.Substring(0, n.Length - 4);
        return n;
    }

    public static WinInfo Find(string[] procNames, string titleIncludes) {
        var names = new List<string>();
        foreach (var n in procNames) { var s = Strip(n); if (s.Length > 0) names.Add(s); }
        foreach (var w in Windows()) {
            bool ok = false;
            foreach (var n in names) if (string.Equals(n, w.Proc, StringComparison.OrdinalIgnoreCase)) { ok = true; break; }
            if (!ok) continue;
            if (!string.IsNullOrEmpty(titleIncludes) && w.Title.IndexOf(titleIncludes, StringComparison.OrdinalIgnoreCase) < 0) continue;
            return w;
        }
        return null;
    }

    public static bool Focus(long hwnd) {
        IntPtr h = new IntPtr(hwnd);
        if (IsIconic(h)) ShowWindow(h, 9); // SW_RESTORE
        if (TryForeground(h)) return true;
        // Foreground lock: an injected input event from this process unlocks SetForegroundWindow.
        // Use SHIFT, not ALT: a lone ALT tap opens the menu bar in Electron apps (Claude, OpenCode)
        // and the paste then lands in the menu instead of the prompt box.
        keybd_event(VK_SHIFT, 0, 0, UIntPtr.Zero);
        keybd_event(VK_SHIFT, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
        return TryForeground(h);
    }

    static bool TryForeground(IntPtr h) {
        uint me = GetCurrentThreadId();
        uint dummy;
        uint fgThread = GetWindowThreadProcessId(GetForegroundWindow(), out dummy);
        bool attached = fgThread != 0 && fgThread != me && AttachThreadInput(me, fgThread, true);
        try {
            SetForegroundWindow(h);
            BringWindowToTop(h);
        } finally {
            if (attached) AttachThreadInput(me, fgThread, false);
        }
        for (int i = 0; i < 10; i++) {
            if (GetForegroundWindow() == h) return true;
            Thread.Sleep(50);
            if (i == 4) { SetForegroundWindow(h); BringWindowToTop(h); }
        }
        return GetForegroundWindow() == h;
    }

    static bool IsWritableEdit(AutomationElement e) {
        try {
            object p;
            if (!e.TryGetCurrentPattern(ValuePattern.Pattern, out p)) return false;
            return !((ValuePattern)p).Current.IsReadOnly;
        } catch { return false; }
    }

    /// Chromium/Electron apps (Claude, OpenCode, ChatGPT) focus the web document, not the prompt box,
    /// when their window is activated. If focus is not in an editor, focus the lowest writable Edit
    /// in the window (chat prompt boxes sit at the bottom). Native editors (Notepad) are left alone.
    public static void EnsureEditorFocus(long hwnd) {
        try {
            AutomationElement f = AutomationElement.FocusedElement;
            if (f != null) {
                ControlType ct = f.Current.ControlType;
                if (ct == ControlType.Edit && IsWritableEdit(f)) return;
                if (ct == ControlType.Document && f.Current.FrameworkId != "Chrome") return;
            }
            AutomationElement root = AutomationElement.FromHandle(new IntPtr(hwnd));
            var edits = root.FindAll(TreeScope.Descendants,
                new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit));
            AutomationElement best = null;
            System.Windows.Rect bestRect = System.Windows.Rect.Empty;
            foreach (AutomationElement e in edits) {
                var c = e.Current;
                if (c.IsOffscreen || !c.IsEnabled || !c.IsKeyboardFocusable) continue;
                if (!IsWritableEdit(e)) continue;
                var r = c.BoundingRectangle;
                if (r.IsEmpty || r.Width < 40) continue;
                if (best == null || r.Bottom > bestRect.Bottom + 1 || (Math.Abs(r.Bottom - bestRect.Bottom) <= 1 && r.Width > bestRect.Width)) {
                    best = e; bestRect = r;
                }
            }
            if (best != null) { best.SetFocus(); Thread.Sleep(150); }
        } catch { }
    }

    /// If keyboard focus sits in a menu (menu-bar mode), leave it with Escape so the paste reaches the editor.
    public static void LeaveMenu() {
        for (int i = 0; i < 2; i++) {
            try {
                AutomationElement el = AutomationElement.FocusedElement;
                if (el == null) return;
                ControlType ct = el.Current.ControlType;
                if (ct != ControlType.MenuItem && ct != ControlType.MenuBar && ct != ControlType.Menu) return;
            } catch { return; }
            Send(Key(VK_ESCAPE, false), Key(VK_ESCAPE, true));
            Thread.Sleep(150);
        }
    }

    static INPUT Key(ushort vk, bool up) {
        var i = new INPUT();
        i.type = 1;
        i.u.ki.wVk = vk;
        i.u.ki.dwFlags = up ? KEYEVENTF_KEYUP : 0u;
        return i;
    }

    static void Send(params INPUT[] inputs) {
        SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
    }

    public static void CtrlV() {
        Send(Key(VK_CONTROL, false), Key(VK_V, false), Key(VK_V, true), Key(VK_CONTROL, true));
    }

    public static void Enter() {
        Send(Key(VK_RETURN, false), Key(VK_RETURN, true));
    }

    /// Text of the focused UI element, or null when it cannot be read.
    public static string ReadFocused() {
        try {
            AutomationElement el = AutomationElement.FocusedElement;
            if (el == null) return null;
            object p;
            if (el.TryGetCurrentPattern(ValuePattern.Pattern, out p)) {
                string v = ((ValuePattern)p).Current.Value;
                if (v != null) return v;
            }
            if (el.TryGetCurrentPattern(TextPattern.Pattern, out p)) {
                return ((TextPattern)p).DocumentRange.GetText(500000);
            }
        } catch { }
        return null;
    }

    static string Norm(string s) {
        var sb = new StringBuilder();
        bool sp = false;
        foreach (char c in s) {
            if (char.IsWhiteSpace(c)) { sp = true; continue; }
            if (sp && sb.Length > 0) sb.Append(' ');
            sp = false;
            sb.Append(char.ToLowerInvariant(c));
        }
        return sb.ToString();
    }

    public static bool Verify(string before, string after, string needle) {
        if (after == null) return false;
        string n = Norm(needle ?? "");
        if (n.Length == 0) return false;
        string a = Norm(after);
        if (a.IndexOf(n, StringComparison.Ordinal) < 0) return false;
        if (before == null) return true;
        string b = Norm(before);
        return b.IndexOf(n, StringComparison.Ordinal) < 0 || after.Length > before.Length;
    }
}
'@

Add-Type -TypeDefinition $src -ReferencedAssemblies 'UIAutomationClient', 'UIAutomationTypes', 'WindowsBase'

$utf8 = New-Object System.Text.UTF8Encoding($false)
$stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $utf8)
$stdout = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $utf8)
$stdout.AutoFlush = $true
$stdout.NewLine = "`n"

function Send-Json($obj) {
    $stdout.WriteLine(($obj | ConvertTo-Json -Compress -Depth 6))
}

function As-Array($v) {
    if ($null -eq $v) { return @() }
    return @($v)
}

function Cmd-Detect($req) {
    $wins = [StubWin]::Windows()
    $result = @{}
    foreach ($t in (As-Array $req.targets)) {
        $found = $false
        $names = @(As-Array $t.processNames | ForEach-Object { ([string]$_).Trim() -replace '(?i)\.exe$', '' })
        foreach ($w in $wins) {
            if ($names -contains $w.Proc -or ($names | Where-Object { $_ -ieq $w.Proc })) {
                if ($t.titleIncludes -and ($w.Title.IndexOf([string]$t.titleIncludes, [StringComparison]::OrdinalIgnoreCase) -lt 0)) { continue }
                $found = $true
                break
            }
        }
        $result[[string]$t.id] = $found
    }
    return @{ ok = $true; found = $result }
}

function Cmd-Paste($req) {
    $names = [string[]](As-Array $req.processNames)
    $title = if ($req.titleIncludes) { [string]$req.titleIncludes } else { '' }
    $w = [StubWin]::Find($names, $title)
    if ($null -eq $w) { return @{ ok = $true; outcome = 'not-found'; submitted = $false } }
    return Paste-Into $w.Hwnd $w.Title $req
}

function Cmd-Find($req) {
    $names = [string[]](As-Array $req.processNames)
    $title = if ($req.titleIncludes) { [string]$req.titleIncludes } else { '' }
    $w = [StubWin]::Find($names, $title)
    if ($null -eq $w) { return @{ ok = $true } }
    return @{ ok = $true; hwnd = $w.Hwnd }
}

function Cmd-PasteImage($req) {
    $hwnd = [long]$req.hwnd
    if (-not [StubWin]::Focus($hwnd)) { return @{ ok = $true; pasted = $false } }
    Start-Sleep -Milliseconds 250
    [StubWin]::LeaveMenu()
    [StubWin]::EnsureEditorFocus($hwnd)
    [StubWin]::CtrlV()
    return @{ ok = $true; pasted = $true }
}

# Reads a chat app's session list from its buttons. Language independent: it relies on how the buttons relate, not on their wording.
#   section header: two buttons on, "new session in <section>" ends with the section's name
#   session row: within two buttons, "<more options>: <title>", and the row's name starts with that title
#   open session: in the header strip, right of the list, "<title>: <rename>"
function Get-ChatUi([long]$hwnd) {
    $root = [Windows.Automation.AutomationElement]::FromHandle([IntPtr]::new($hwnd))
    $cond = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::Button)
    $box = $root.Current.BoundingRectangle
    $els = @(); $names = @(); $xs = @(); $ys = @(); $rs = @()
    foreach ($e in $root.FindAll([Windows.Automation.TreeScope]::Descendants, $cond)) {
        try {
            $c = $e.Current; $r = $c.BoundingRectangle
            $x = [int]$r.X; $y = [int]($r.Y - $box.Y); $right = [int]$r.Right; $n = [string]$c.Name
            $els += $e; $names += $n; $xs += $x; $ys += $y; $rs += $right
        } catch { }
    }
    $group = ''; $groupX = $null; $chats = @(); $groups = @(); $newEls = @{}; $listRight = 0
    for ($i = 0; $i -lt $names.Count; $i++) {
        $n = $names[$i]
        if (-not $n) { continue }
        if ($null -ne $groupX -and [Math]::Abs($xs[$i] - $groupX) -gt 20) { continue }
        $isRow = $false
        foreach ($off in 1, 2) {
            if ($group -and $i + $off -lt $names.Count -and $names[$i + $off] -match '^[^:]+: (.+)$' -and $n.StartsWith($Matches[1])) {
                $chats += [pscustomobject]@{ group = $group; title = $Matches[1]; el = $els[$i] }
                if ($rs[$i] -gt $listRight) { $listRight = $rs[$i] }
                $isRow = $true
                break
            }
        }
        if ($isRow) { continue }
        if ($i + 2 -lt $names.Count -and $names[$i + 2].EndsWith($n) -and $names[$i + 2].Length -gt $n.Length -and -not $names[$i + 1].Contains($n)) {
            $group = $n
            if ($null -eq $groupX) { $groupX = $xs[$i] }
            if ($groups -notcontains $n) { $groups += $n; $newEls[$n] = $els[$i + 2] }
        }
    }
    $current = $null
    if ($listRight -gt 0) {
        for ($i = 0; $i -lt $names.Count; $i++) {
            if ($ys[$i] -ge 0 -and $ys[$i] -lt 100 -and $xs[$i] -ge $listRight -and $names[$i] -match '^(.+): [^:]+$') { $current = $Matches[1]; break }
        }
    }
    # panels other than the session list can look like a section; a real section has sessions
    $groups = @($groups | Where-Object { $g = $_; @($chats | Where-Object { $_.group -eq $g }).Count -gt 0 })
    return @{ chats = $chats; groups = $groups; newEls = $newEls; current = $current }
}

# Chromium only builds its accessibility tree once something asks, so the first read of a fresh window can be empty.
function Get-ChatUiPatient([long]$hwnd) {
    $ui = Get-ChatUi $hwnd
    for ($i = 0; $i -lt 6 -and @($ui.chats).Count -eq 0; $i++) {
        Start-Sleep -Milliseconds 500
        $ui = Get-ChatUi $hwnd
    }
    return $ui
}

function Invoke-Button($el) {
    $pat = $null
    if (-not $el.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern, [ref]$pat)) { return $false }
    $pat.Invoke()
    return $true
}

function Cmd-ListChats($req) {
    $ui = Get-ChatUiPatient ([long]$req.hwnd)
    $list = @($ui.chats | ForEach-Object { @{ group = $_.group; title = $_.title } })
    return @{ ok = $true; chats = $list; groups = @($ui.groups) }
}

function Cmd-OpenChat($req) {
    $hwnd = [long]$req.hwnd
    if (-not [StubWin]::Focus($hwnd)) { return @{ ok = $true; opened = $false } }
    Start-Sleep -Milliseconds 200
    $ui = Get-ChatUiPatient $hwnd
    if ($null -ne $req.title) {
        $title = [string]$req.title
        $row = @($ui.chats | Where-Object { $_.group -eq [string]$req.group -and $_.title -eq $title }) | Select-Object -First 1
        if ($null -eq $row) { return @{ ok = $true; opened = $false } }
        if ($ui.current -eq $title) { return @{ ok = $true; opened = $true } }
        if (-not (Invoke-Button $row.el)) { return @{ ok = $true; opened = $false } }
        for ($i = 0; $i -lt 50; $i++) {
            Start-Sleep -Milliseconds 100
            if ((Get-ChatUi $hwnd).current -eq $title) { Start-Sleep -Milliseconds 300; return @{ ok = $true; opened = $true } }
        }
        return @{ ok = $true; opened = $false }
    }
    $btn = $ui.newEls[[string]$req.group]
    if ($null -eq $btn) { return @{ ok = $true; opened = $false } }
    $before = $ui.current
    if (-not (Invoke-Button $btn)) { return @{ ok = $true; opened = $false } }
    if ($null -eq $before) { Start-Sleep -Milliseconds 500; return @{ ok = $true; opened = $true } } # already on an empty session
    for ($i = 0; $i -lt 50; $i++) {
        Start-Sleep -Milliseconds 100
        if ((Get-ChatUi $hwnd).current -ne $before) { Start-Sleep -Milliseconds 300; return @{ ok = $true; opened = $true } }
    }
    return @{ ok = $true; opened = $false }
}

function Cmd-AtCursor {
    $w = [StubWin]::AtCursor()
    if ($null -eq $w) { return @{ ok = $true } }
    return @{ ok = $true; hwnd = $w.Hwnd; proc = $w.Proc; title = $w.Title }
}

function Paste-Into([long]$hwnd, [string]$windowTitle, $req) {
    if (-not [StubWin]::Focus($hwnd)) {
        return @{ ok = $true; outcome = 'focus-failed'; submitted = $false; windowTitle = $windowTitle }
    }
    Start-Sleep -Milliseconds 250
    [StubWin]::LeaveMenu()
    [StubWin]::EnsureEditorFocus($hwnd)
    $before = [StubWin]::ReadFocused()
    if ($null -eq $before) { Start-Sleep -Milliseconds 200; $before = [StubWin]::ReadFocused() }
    [StubWin]::CtrlV()
    # UI Automation trees update asynchronously (Notepad, Chromium): poll instead of a single read.
    $after = $null
    $verified = $false
    for ($i = 0; $i -lt 8 -and -not $verified; $i++) {
        Start-Sleep -Milliseconds 200
        $after = [StubWin]::ReadFocused()
        $verified = [StubWin]::Verify($before, $after, [string]$req.needle)
    }
    $submitted = $false
    if ($verified -and $req.submit) {
        [StubWin]::Enter()
        $submitted = $true
    }
    $outcome = if ($verified) { 'verified' } else { 'unverified' }
    return @{ ok = $true; outcome = $outcome; submitted = $submitted; windowTitle = $windowTitle; readable = ($null -ne $after) }
}

function Cmd-Focus($req) {
    $okf = [StubWin]::Focus([long]$req.hwnd)
    return @{ ok = $true; focused = $okf }
}

Send-Json @{ ready = $true }

while ($true) {
    $line = $stdin.ReadLine()
    if ($null -eq $line) { break }
    if ($line.Trim().Length -eq 0) { continue }
    $id = $null
    try {
        $req = $line | ConvertFrom-Json
        $id = $req.id
        switch ($req.cmd) {
            'ping'   { $res = @{ ok = $true } }
            'detect' { $res = Cmd-Detect $req }
            'paste'  { $res = Cmd-Paste $req }
            'pasteInto' { $res = Paste-Into ([long]$req.hwnd) ([string]$req.title) $req }
            'atCursor' { $res = Cmd-AtCursor }
            'find' { $res = Cmd-Find $req }
            'listChats' { $res = Cmd-ListChats $req }
            'openChat' { $res = Cmd-OpenChat $req }
            'pasteImage' { $res = Cmd-PasteImage $req }
            'focus'  { $res = Cmd-Focus $req }
            default  { $res = @{ ok = $false; error = "unknown cmd" } }
        }
    } catch {
        $res = @{ ok = $false; error = $_.Exception.Message }
    }
    $res['id'] = $id
    Send-Json $res
}
