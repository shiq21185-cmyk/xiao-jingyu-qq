# 读取/设置 Windows 默认音频端点（console / multimedia / communications 三个角色）
# 用法:
#   powershell -File audio_defaults.ps1 -Action get
#   powershell -File audio_defaults.ps1 -Action set -Role communications -Kind capture -Match "CABLE Output"
param(
  [ValidateSet('get','set')] [string]$Action = 'get',
  [ValidateSet('console','multimedia','communications')] [string]$Role = 'communications',
  [ValidateSet('render','capture')] [string]$Kind = 'render',
  [string]$Match = ''
)

$code = @'
using System;
using System.Runtime.InteropServices;

namespace AudioCfg {
  [ComImport, Guid("870AF99C-171D-4F9E-AF0D-E63DF40C2BC9")]
  public class CPolicyConfigClient { }

  [Guid("f8679f50-850a-41cf-9c72-430f290290c8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IPolicyConfig {
    int GetMixFormat(string pszDeviceName, IntPtr ppFormat);
    int GetDeviceFormat(string pszDeviceName, bool bDefault, IntPtr ppFormat);
    int ResetDeviceFormat(string pszDeviceName);
    int SetDeviceFormat(string pszDeviceName, IntPtr pEndpointFormat, IntPtr MixFormat);
    int GetProcessingPeriod(string pszDeviceName, bool bDefault, IntPtr pmftDefaultPeriod, IntPtr pmftMinimumPeriod);
    int SetProcessingPeriod(string pszDeviceName, IntPtr pmftPeriod);
    int GetShareMode(string pszDeviceName, IntPtr pMode);
    int SetShareMode(string pszDeviceName, IntPtr mode);
    int GetPropertyValue(string pszDeviceName, bool bFxStore, ref PROPERTYKEY key, IntPtr pv);
    int SetPropertyValue(string pszDeviceName, bool bFxStore, ref PROPERTYKEY key, IntPtr pv);
    int SetDefaultEndpoint(string pszDeviceName, int role);
    int SetEndpointVisibility(string pszDeviceName, bool bVisible);
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct PROPERTYKEY { public Guid fmtid; public int pid; }

  // MMDevice API
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
  public class MMDeviceEnumeratorComObject { }

  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
    int GetDevice(string id, out IMMDevice device);
    int RegisterEndpointNotificationCallback(IntPtr client);
    int UnregisterEndpointNotificationCallback(IntPtr client);
  }

  [Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IMMDeviceCollection {
    int GetCount(out int count);
    int Item(int index, out IMMDevice device);
  }

  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IMMDevice {
    int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, out IntPtr iface);
    int OpenPropertyStore(int access, out IPropertyStore store);
    int GetId(out string id);
    int GetState(out int state);
  }

  [Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IPropertyStore {
    int GetCount(out int count);
    int GetAt(int index, out PROPERTYKEY key);
    int GetValue(ref PROPERTYKEY key, out PROPVARIANT value);
    int SetValue(ref PROPERTYKEY key, ref PROPVARIANT value);
    int Commit();
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct PROPVARIANT {
    public short vt; public short r1; public short r2; public short r3;
    public IntPtr p;
  }

  public static class Api {
    static PROPERTYKEY PKEY_Device_FriendlyName =
      new PROPERTYKEY { fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), pid = 14 };

    public static string FriendlyName(IMMDevice dev) {
      IPropertyStore store;
      if (dev.OpenPropertyStore(0, out store) != 0) return "?";
      PROPVARIANT pv;
      if (store.GetValue(ref PKEY_Device_FriendlyName, out pv) != 0) return "?";
      return Marshal.PtrToStringUni(pv.p) ?? "?";
    }

    // 列出所有端点: flow 0=render 1=capture, role 0/1/2
    public static string[] List(int flow, int role) {
      var en = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
      IMMDevice def;
      string defId = "";
      if (en.GetDefaultAudioEndpoint(flow, role, out def) == 0) def.GetId(out defId);
      IMMDeviceCollection col;
      en.EnumAudioEndpoints(flow, 1, out col); // 1 = DEVICE_STATE_ACTIVE
      int n; col.GetCount(out n);
      var res = new System.Collections.Generic.List<string>();
      for (int i = 0; i < n; i++) {
        IMMDevice d; col.Item(i, out d);
        string id; d.GetId(out id);
        res.Add((id == defId ? "*" : " ") + " " + FriendlyName(d) + " :: " + id);
      }
      return res.ToArray();
    }

    // 设置默认端点: kindName 为设备友好名（子串匹配）
    public static string SetDefault(int flow, int role, string match) {
      var en = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
      IMMDeviceCollection col;
      en.EnumAudioEndpoints(flow, 1, out col);
      int n; col.GetCount(out n);
      for (int i = 0; i < n; i++) {
        IMMDevice d; col.Item(i, out d);
        string name = FriendlyName(d);
        if (name.IndexOf(match, StringComparison.OrdinalIgnoreCase) < 0) continue;
        string id; d.GetId(out id);
        var pc = (IPolicyConfig)(new CPolicyConfigClient());
        // role: 0=console 1=multimedia 2=communications
        int hr1 = pc.SetDefaultEndpoint(id, 0);
        int hr2 = pc.SetDefaultEndpoint(id, 1);
        int hr3 = pc.SetDefaultEndpoint(id, 2);
        return "OK " + name + " hresult=" + hr1 + "/" + hr2 + "/" + hr3;
      }
      return "NOTFOUND " + match;
    }
  }
}
'@

Add-Type -TypeDefinition $code -Language CSharp

$flowName = if ($Kind -eq 'render') { 'render' } else { 'capture' }
$flow = if ($Kind -eq 'render') { 0 } else { 1 }

if ($Action -eq 'get') {
  foreach ($r in 0, 1, 2) {
    $rn = @('console', 'multimedia', 'communications')[$r]
    Write-Output "=== $flowName / role=$rn ==="
    [AudioCfg.Api]::List($flow, $r) | ForEach-Object { Write-Output $_ }
  }
} else {
  $roleNum = @{ console = 0; multimedia = 1; communications = 2 }[$Role]
  $r = [AudioCfg.Api]::SetDefault($flow, $roleNum, $Match)
  Write-Output $r
}
