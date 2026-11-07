# HoloLoop display power helper. ASCII only; saved with a UTF-8 BOM.
# Usage: display-power.ps1 <command> [args]
#   list                      -> JSON of monitors with size and DDC/CI brightness
#   get   <w> <h>             -> brightness of the monitor with that pixel size
#   set   <w> <h> <0-100>     -> set its brightness (DDC/CI)
#   off                       -> turn every display's signal off (wakes on input)
#   wake                      -> nudge the mouse so Windows turns displays back on
param([string]$cmd = 'list', [int]$w = 1440, [int]$h = 2560, [int]$val = -1)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;
public static class HLDisp {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct MONITORINFOEX { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct PHYSICAL_MONITOR { public IntPtr h; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string desc; }
  public delegate bool MonEnum(IntPtr hMon, IntPtr hdc, ref RECT r, IntPtr data);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonEnum cb, IntPtr data);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool GetMonitorInfo(IntPtr hMon, ref MONITORINFOEX mi);
  [DllImport("dxva2.dll")] public static extern bool GetNumberOfPhysicalMonitorsFromHMONITOR(IntPtr hMon, out uint n);
  [DllImport("dxva2.dll")] public static extern bool GetPhysicalMonitorsFromHMONITOR(IntPtr hMon, uint n, [Out] PHYSICAL_MONITOR[] arr);
  [DllImport("dxva2.dll")] public static extern bool GetMonitorBrightness(IntPtr h, out uint min, out uint cur, out uint max);
  [DllImport("dxva2.dll")] public static extern bool SetMonitorBrightness(IntPtr h, uint v);
  [DllImport("dxva2.dll")] public static extern bool DestroyPhysicalMonitors(uint n, PHYSICAL_MONITOR[] arr);
  [DllImport("user32.dll")] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, IntPtr wp, IntPtr lp, uint flags, uint timeout, out IntPtr res);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint data, UIntPtr extra);

  public static List<string> List() {
    var outp = new List<string>();
    EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, (IntPtr hm, IntPtr dc, ref RECT r, IntPtr d) => {
      var mi = new MONITORINFOEX(); mi.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX));
      GetMonitorInfo(hm, ref mi);
      int mw = mi.rcMonitor.R - mi.rcMonitor.L, mh = mi.rcMonitor.B - mi.rcMonitor.T;
      string ddc = "null";
      uint n; if (GetNumberOfPhysicalMonitorsFromHMONITOR(hm, out n) && n > 0) {
        var arr = new PHYSICAL_MONITOR[n];
        if (GetPhysicalMonitorsFromHMONITOR(hm, n, arr)) {
          uint mn, cur, mx; if (GetMonitorBrightness(arr[0].h, out mn, out cur, out mx)) ddc = "{\"min\":" + mn + ",\"cur\":" + cur + ",\"max\":" + mx + "}";
          DestroyPhysicalMonitors(n, arr);
        }
      }
      outp.Add("{\"device\":\"" + mi.szDevice.Replace("\\", "\\\\") + "\",\"w\":" + mw + ",\"h\":" + mh + ",\"x\":" + mi.rcMonitor.L + ",\"y\":" + mi.rcMonitor.T + ",\"brightness\":" + ddc + "}");
      return true; }, IntPtr.Zero);
    return outp;
  }
  public static int Brightness(int w, int h, int set) {
    int result = -2;
    EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, (IntPtr hm, IntPtr dc, ref RECT r, IntPtr d) => {
      var mi = new MONITORINFOEX(); mi.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX));
      GetMonitorInfo(hm, ref mi);
      int mw = mi.rcMonitor.R - mi.rcMonitor.L, mh = mi.rcMonitor.B - mi.rcMonitor.T;
      if (!((mw == w && mh == h) || (mw == h && mh == w))) return true;
      uint n; if (!GetNumberOfPhysicalMonitorsFromHMONITOR(hm, out n) || n == 0) { result = -1; return false; }
      var arr = new PHYSICAL_MONITOR[n];
      if (GetPhysicalMonitorsFromHMONITOR(hm, n, arr)) {
        uint mn, cur, mx;
        if (set >= 0) { result = SetMonitorBrightness(arr[0].h, (uint)set) ? set : -1; }
        else { result = GetMonitorBrightness(arr[0].h, out mn, out cur, out mx) ? (int)cur : -1; }
        DestroyPhysicalMonitors(n, arr);
      }
      return false; }, IntPtr.Zero);
    return result;
  }
  public static void Off() { IntPtr res; SendMessageTimeout((IntPtr)0xffff, 0x0112, (IntPtr)0xF170, (IntPtr)2, 2, 2000, out res); }
  public static void Wake() { mouse_event(0x0001, 1, 0, 0, UIntPtr.Zero); System.Threading.Thread.Sleep(40); mouse_event(0x0001, -1, 0, 0, UIntPtr.Zero); }
}
"@
[void][HLDisp]::SetProcessDPIAware()
switch ($cmd) {
  'list' { '[' + ([HLDisp]::List() -join ',') + ']' }
  'get'  { [HLDisp]::Brightness($w, $h, -1) }
  'set'  { [HLDisp]::Brightness($w, $h, $val) }
  'off'  { [HLDisp]::Off(); 'ok' }
  'wake' { [HLDisp]::Wake(); 'ok' }
  default { throw "unknown command $cmd" }
}
