param([switch]$Restart, [switch]$Interactive, [switch]$Quick, [switch]$Regression, [switch]$Package, [switch]$VerifyPackage, [switch]$Icons)
$ErrorActionPreference = 'Stop'
$scriptDirectory = if ($PSScriptRoot) { $PSScriptRoot } else { Join-Path (Get-Location).Path 'scripts' }
$project = Split-Path -Parent $scriptDirectory
$output = Join-Path $project '.smoke'
New-Item -ItemType Directory -Force -Path $output | Out-Null
# Assign the suspended root to an owned Job Object before any Electron child can
# start. Closing this handle (including cancellation) kills only this test tree.
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public sealed class DotTestJob : IDisposable {
  [StructLayout(LayoutKind.Sequential)] struct SI { public int cb; public IntPtr reserved, desktop, title; public int x,y,cx,cy,xc,yc,fill,flags; public short show,reserved2; public IntPtr reservedPtr,input,output,error; }
  [StructLayout(LayoutKind.Sequential)] struct PI { public IntPtr process,thread; public uint pid,tid; }
  [StructLayout(LayoutKind.Sequential)] struct BASIC { public long user,process; public uint flags; public UIntPtr min,max; public uint active; public UIntPtr affinity; public uint priority,scheduling; }
  [StructLayout(LayoutKind.Sequential)] struct IO { public ulong a,b,c,d,e,f; }
  [StructLayout(LayoutKind.Sequential)] struct LIMITS { public BASIC basic; public IO io; public UIntPtr processMemory,jobMemory,peakProcess,peakJob; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attrs,string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int cls,ref LIMITS data,int size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int cls,IntPtr data,int size,IntPtr returned);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string exe,StringBuilder cmd,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref SI si,out PI pi);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint ms);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr handle,out uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateJobObject(IntPtr job,uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  IntPtr job; PI child;
  public uint Pid { get { return child.pid; } }
  public DotTestJob(string exe,string args,string cwd) {
    job=CreateJobObject(IntPtr.Zero,null);
    var limits=new LIMITS(); limits.basic.flags=0x2000;
    if(job==IntPtr.Zero || !SetInformationJobObject(job,9,ref limits,Marshal.SizeOf(limits))) throw new System.ComponentModel.Win32Exception();
    var si=new SI(); si.cb=Marshal.SizeOf(si);
    if(!CreateProcess(exe,new StringBuilder("\""+exe+"\" "+args),IntPtr.Zero,IntPtr.Zero,false,4,IntPtr.Zero,cwd,ref si,out child)) { CloseHandle(job); throw new System.ComponentModel.Win32Exception(); }
    if(!AssignProcessToJobObject(job,child.process)) { TerminateProcess(child.process,1); WaitForSingleObject(child.process,5000); CloseHandle(child.thread); CloseHandle(child.process); CloseHandle(job); throw new System.ComponentModel.Win32Exception(); }
    ResumeThread(child.thread); CloseHandle(child.thread);
  }
  public bool Wait(int ms) { return WaitForSingleObject(child.process,(uint)ms)==0; }
  public uint ExitCode { get { uint code; GetExitCodeProcess(child.process,out code); return code; } }
  public int Active { get { var p=Marshal.AllocHGlobal(48); try { if(!QueryInformationJobObject(job,1,p,48,IntPtr.Zero)) throw new System.ComponentModel.Win32Exception(); return Marshal.ReadInt32(p,40); } finally { Marshal.FreeHGlobal(p); } } }
  public void Stop() { TerminateJobObject(job,1); }
  public void Dispose() { if(job!=IntPtr.Zero) { TerminateJobObject(job,1); CloseHandle(job); job=IntPtr.Zero; } if(child.process!=IntPtr.Zero) { CloseHandle(child.process); child.process=IntPtr.Zero; } }
}
'@
$env:DOT_SMOKE_PROFILE = Join-Path $output $(if ($Regression) { 'regression-profile' } else { 'profile' })
$env:DOT_SMOKE_RUNNER = Join-Path $scriptDirectory $(if ($Regression) { 'regression.cjs' } else { 'smoke.cjs' })
$env:DOT_SMOKE_RESTART = if ($Restart) { '1' } else { '' }
$env:DOT_SMOKE_INTERACTIVE = if ($Interactive) { '1' } else { '' }
$env:DOT_SMOKE_QUICK = if ($Quick) { '1' } else { '' }
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$ownedJob = $null
try {
  if ($Icons) {
    $iconScript = Join-Path $project 'scripts\build-icons.cjs'
    $ownedJob = [DotTestJob]::new((Join-Path $project 'node_modules\electron\dist\electron.exe'), ('"' + $iconScript + '"'), $project)
  } elseif ($VerifyPackage) {
    $nodePath = (Get-Command node.exe).Source
    $verifyPath = Join-Path $project 'scripts\verify-package.cjs'
    $ownedJob = [DotTestJob]::new($nodePath, ('"' + $verifyPath + '"'), $project)
  } elseif ($Package) {
    $nodePath = (Get-Command node.exe).Source
    $builderPath = Join-Path $project 'node_modules\electron-builder\cli.js'
    $ownedJob = [DotTestJob]::new($nodePath, ('"' + $builderPath + '" --win --x64 --publish never'), $project)
  } else {
    $ownedJob = [DotTestJob]::new((Join-Path $project 'node_modules\electron\dist\electron.exe'), '.', $project)
  }
  $identity = Get-Process -Id $ownedJob.Pid
  @{ pid=$ownedJob.Pid; created=$identity.StartTime.ToUniversalTime().ToString('o'); profile=$env:DOT_SMOKE_PROFILE } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $output 'process.json')
  $deadline = [DateTime]::UtcNow.AddSeconds($(if ($Package) { 900 } elseif ($Interactive) { 260 } else { 80 }))
  while (-not $ownedJob.Wait(500)) { if ([DateTime]::UtcNow -gt $deadline) { throw 'Smoke run timed out' } }
  Write-Output "Owned process exit: $($ownedJob.ExitCode)"
  if ($ownedJob.ExitCode -ne 0) { throw "Owned build/test failed; review the output and .smoke failure evidence" }
} finally {
  if ($ownedJob) {
    $ownedJob.Stop()
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while ($ownedJob.Active -gt 0 -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
    $remaining = $ownedJob.Active
    @{ remainingOwnedProcesses=$remaining; verifiedAt=[DateTime]::UtcNow.ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $output 'cleanup.json')
    $ownedJob.Dispose()
    if ($remaining -ne 0) { throw "Owned test job still had $remaining processes" }
    Write-Output 'Cleanup verified: zero owned test processes'
  }
  Remove-Item Env:DOT_SMOKE_PROFILE,Env:DOT_SMOKE_RUNNER,Env:DOT_SMOKE_RESTART,Env:DOT_SMOKE_INTERACTIVE,Env:DOT_SMOKE_QUICK -ErrorAction SilentlyContinue
}
