import { execFile } from 'node:child_process';
import { cleanError } from './windows-media';

/**
 * Windows' default sound output — where every app without its own routing plays (message
 * sounds, system beeps, browser tabs).
 *
 * Why Studio cares: HQPlayer drives the DAC through ASIO. If the DAC (or the virtual cable) is
 * also Windows' default output, any other app's sound makes Windows open that same device and
 * the music turns into noise or goes silent (found on the owner's PC, 2026-11-17: a WeChat
 * message while the DAC was the default output). Studio can read which output is the default
 * and switch it to an "everyday" output while Apple Music plays.
 *
 * Reading uses the documented Core Audio interfaces (IMMDeviceEnumerator). Switching uses
 * IPolicyConfig, which Windows' own Sound panel uses but Microsoft does not document; the
 * declarations follow the widely used AudioDeviceCmdlets project. Everything runs in a short
 * Windows PowerShell process, like `windows-media.ts`, so there is no native add-on.
 *
 * NOT YET RUN ON WINDOWS: written on a Mac. Failures reach the page as text.
 */
export interface SoundOutput {
  /** Windows endpoint id, e.g. `{0.0.0.00000000}.{6f1c…}`. */
  id: string;
  /** What the Sound panel shows, e.g. "Speakers (Realtek Audio)". */
  name: string;
}

export interface SoundDefaults {
  /** "Default Device" (system sounds, most apps). */
  console: string | null;
  /** Media players that ask for the multimedia role; the Sound panel sets it with `console`. */
  multimedia: string | null;
  /** "Default Communication Device" (calls, chat apps). */
  communications: string | null;
}

export interface SoundOutputs {
  /** Active playback endpoints. */
  outputs: SoundOutput[];
  defaults: SoundDefaults;
}

export type SoundRole = keyof SoundDefaults;

export const SOUND_ROLES: readonly SoundRole[] = ['console', 'multimedia', 'communications'];

export interface WindowsSound {
  /** False on anything but Windows. */
  readonly supported: boolean;
  /** Demo data (mock engine) — never evidence of a real PC. */
  readonly simulated: boolean;
  read(): Promise<SoundOutputs>;
  /** Make `id` Windows' default output for these roles; answers with what Windows says after. */
  setDefault(id: string, roles: readonly SoundRole[]): Promise<SoundOutputs>;
}

/** Endpoint ids are braces, digits, dots, hex and dashes; anything else never reaches a script. */
export const isSoundOutputId = (value: string): boolean =>
  /^\{[0-9.]{1,40}\}\.\{[0-9a-fA-F-]{36}\}$/.test(value);

const ROLE_NUMBER: Record<SoundRole, number> = { console: 0, multimedia: 1, communications: 2 };

// --- PowerShell ---------------------------------------------------------------------------------

/**
 * C# 5 (what Windows PowerShell 5.1 compiles). Interface methods are in vtable order; the first
 * ten slots of IPolicyConfig are never called and only keep SetDefaultEndpoint in 11th place.
 */
const PRELUDE = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

namespace HqpsSound {
  [StructLayout(LayoutKind.Sequential)]
  public struct PropertyKey { public Guid fmtid; public int pid; }

  [StructLayout(LayoutKind.Explicit)]
  public struct PropVariant {
    [FieldOffset(0)] public short vt;
    [FieldOffset(8)] public IntPtr pointerValue;
    [FieldOffset(16)] public IntPtr padding;
  }

  [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPropertyStore {
    [PreserveSig] int GetCount(out int count);
    [PreserveSig] int GetAt(int index, out PropertyKey key);
    [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant value);
    [PreserveSig] int SetValue(ref PropertyKey key, ref PropVariant value);
    [PreserveSig] int Commit();
  }

  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice {
    [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object instance);
    [PreserveSig] int OpenPropertyStore(int access, out IPropertyStore properties);
    [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    [PreserveSig] int GetState(out int state);
  }

  [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceCollection {
    [PreserveSig] int GetCount(out int count);
    [PreserveSig] int Item(int index, out IMMDevice device);
  }

  [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator {
    [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
    [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
    [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
  }

  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
  class MMDeviceEnumeratorClass { }

  [ComImport, Guid("f8679f50-850a-41cf-9c72-430f290290c8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPolicyConfig {
    [PreserveSig] int Slot01();
    [PreserveSig] int Slot02();
    [PreserveSig] int Slot03();
    [PreserveSig] int Slot04();
    [PreserveSig] int Slot05();
    [PreserveSig] int Slot06();
    [PreserveSig] int Slot07();
    [PreserveSig] int Slot08();
    [PreserveSig] int Slot09();
    [PreserveSig] int Slot10();
    [PreserveSig] int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string deviceId, int role);
  }

  [ComImport, Guid("870af99c-171d-4f9e-af0d-e63df40c2bc9")]
  class PolicyConfigClientClass { }

  public static class Sound {
    [DllImport("ole32.dll")]
    static extern int PropVariantClear(ref PropVariant value);

    static void Check(int hr) {
      if (hr < 0) Marshal.ThrowExceptionForHR(hr);
    }

    static IMMDeviceEnumerator Enumerator() {
      return (IMMDeviceEnumerator)(new MMDeviceEnumeratorClass());
    }

    static string Name(IMMDevice device) {
      IPropertyStore store;
      if (device.OpenPropertyStore(0, out store) < 0 || store == null) return "";
      PropertyKey key = new PropertyKey();
      key.fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0");
      key.pid = 14;
      PropVariant value;
      if (store.GetValue(ref key, out value) < 0) return "";
      string name = value.vt == 31 && value.pointerValue != IntPtr.Zero
        ? Marshal.PtrToStringUni(value.pointerValue)
        : "";
      PropVariantClear(ref value);
      return name == null ? "" : name;
    }

    // Active playback endpoints, one "id<TAB>name" per line.
    public static string[] Outputs() {
      IMMDeviceCollection devices;
      Check(Enumerator().EnumAudioEndpoints(0, 1, out devices));
      int count;
      Check(devices.GetCount(out count));
      List<string> rows = new List<string>();
      for (int i = 0; i < count; i++) {
        IMMDevice device;
        if (devices.Item(i, out device) < 0 || device == null) continue;
        string id;
        if (device.GetId(out id) < 0 || String.IsNullOrEmpty(id)) continue;
        rows.Add(id + "\t" + Name(device));
      }
      return rows.ToArray();
    }

    // The default playback endpoint for a role (0 console, 1 multimedia, 2 communications).
    public static string DefaultOutput(int role) {
      IMMDevice device;
      if (Enumerator().GetDefaultAudioEndpoint(0, role, out device) < 0 || device == null) return "";
      string id;
      if (device.GetId(out id) < 0 || id == null) return "";
      return id;
    }

    public static void SetDefaultOutput(string id, int role) {
      IPolicyConfig config = (IPolicyConfig)(new PolicyConfigClientClass());
      Check(config.SetDefaultEndpoint(id, role));
    }
  }
}
'@
function Read-Sound {
  $outputs = @()
  foreach ($row in [HqpsSound.Sound]::Outputs()) {
    $cut = $row.IndexOf([char]9)
    $outputs += [pscustomobject]@{ id = $row.Substring(0, $cut); name = $row.Substring($cut + 1) }
  }
  ConvertTo-Json -Compress -Depth 4 -InputObject ([pscustomobject]@{
    outputs = @($outputs)
    console = [HqpsSound.Sound]::DefaultOutput(0)
    multimedia = [HqpsSound.Sound]::DefaultOutput(1)
    communications = [HqpsSound.Sound]::DefaultOutput(2)
  })
}
`;

const READ = String.raw`
Read-Sound
`;

const SET = String.raw`
foreach ($role in @(__ROLES__)) { [HqpsSound.Sound]::SetDefaultOutput('__ID__', $role) }
Read-Sound
`;

const POWERSHELL_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];

function runPowerShell(script: string, timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      // -EncodedCommand takes UTF-16LE base64, which avoids every quoting problem.
      [...POWERSHELL_ARGS, '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) reject(new Error(cleanError(String(stderr || err.message))));
        else resolve(stdout);
      },
    );
  });
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const record = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};

/** Turn the PowerShell JSON into typed outputs; anything unexpected is dropped. */
export function parseSound(stdout: string): SoundOutputs {
  const start = stdout.indexOf('{');
  if (start < 0) throw new Error('Windows gave no answer about its sound outputs');
  const r = record(JSON.parse(stdout.slice(start).trim()));
  // PowerShell writes a one-item list as a bare object.
  const rows = Array.isArray(r.outputs) ? r.outputs : r.outputs ? [r.outputs] : [];
  const outputs = rows
    .map(record)
    .map((o) => ({ id: text(o.id), name: text(o.name).trim() || text(o.id) }))
    .filter((o) => isSoundOutputId(o.id));
  const id = (v: unknown): string | null => (isSoundOutputId(text(v)) ? text(v) : null);
  return {
    outputs,
    defaults: {
      console: id(r.console),
      multimedia: id(r.multimedia),
      communications: id(r.communications),
    },
  };
}

class PowerShellSound implements WindowsSound {
  readonly supported = true;
  readonly simulated = false;

  async read(): Promise<SoundOutputs> {
    return parseSound(await runPowerShell(PRELUDE + READ));
  }

  async setDefault(id: string, roles: readonly SoundRole[]): Promise<SoundOutputs> {
    if (!isSoundOutputId(id)) throw new Error('Not a Windows sound output');
    const numbers = [...new Set(roles.map((r) => ROLE_NUMBER[r]))].join(', ');
    if (numbers === '') return this.read();
    const script = PRELUDE + SET.replace('__ROLES__', numbers).replace('__ID__', () => id);
    return parseSound(await runPowerShell(script));
  }
}

class UnsupportedSound implements WindowsSound {
  readonly supported = false;
  readonly simulated = false;
  async read(): Promise<SoundOutputs> {
    return { outputs: [], defaults: { console: null, multimedia: null, communications: null } };
  }
  async setDefault(): Promise<SoundOutputs> {
    throw new Error('Only available on Windows');
  }
}

export function windowsSound(platform: string = process.platform): WindowsSound {
  return platform === 'win32' ? new PowerShellSound() : new UnsupportedSound();
}

// --- demo ---------------------------------------------------------------------------------------

const DEMO_ID = (n: number): string => `{0.0.0.00000000}.{00000000-0000-4000-8000-00000000000${n}}`;

/**
 * A pretend Windows for the mock engine: a DAC that is the default output (the risky set-up), a
 * virtual cable and ordinary speakers. Flagged `simulated` all the way to the screen.
 */
export class SimulatedSound implements WindowsSound {
  readonly supported = true;
  readonly simulated = true;
  private readonly outputs: SoundOutput[] = [
    { id: DEMO_ID(1), name: 'Simulated DAC (demo)' },
    { id: DEMO_ID(2), name: 'Simulated Virtual Cable (demo)' },
    { id: DEMO_ID(3), name: 'Speakers (demo)' },
  ];
  private defaults: SoundDefaults = {
    console: DEMO_ID(1),
    multimedia: DEMO_ID(1),
    communications: DEMO_ID(1),
  };

  async read(): Promise<SoundOutputs> {
    return { outputs: this.outputs.map((o) => ({ ...o })), defaults: { ...this.defaults } };
  }

  async setDefault(id: string, roles: readonly SoundRole[]): Promise<SoundOutputs> {
    if (!this.outputs.some((o) => o.id === id)) throw new Error('No such sound output');
    for (const role of roles) this.defaults[role] = id;
    return this.read();
  }
}
