param([Parameter(Mandatory = $true)][string]$RequestBase64)
$ErrorActionPreference = 'Stop'
$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($RequestBase64)) | ConvertFrom-Json

# Windows command-line quoting, independent of PowerShell expression parsing.
function Quote-Argument([string]$value) {
    $value = [regex]::Replace($value, '(\\*)"', '$1$1\"')
    $value = [regex]::Replace($value, '(\\+)$', '$1$1')
    return '"' + $value + '"'
}

try {
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = (Get-Command dotnet.exe -ErrorAction Stop).Source
    $arguments = @((Join-Path $PSScriptRoot 'DigitalArch.Service.dll')) + @($request.args)
    $info.Arguments = ($arguments | ForEach-Object { Quote-Argument ([string]$_) }) -join ' '
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $info
    [void]$process.Start()
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    $watch = [Diagnostics.Stopwatch]::StartNew()
    while (-not $process.WaitForExit(200)) {
      if ($watch.ElapsedMilliseconds -ge [int]$request.timeoutMs -or ($request.cancelFile -and (Test-Path -LiteralPath $request.cancelFile))) {
        # Linux killing powershell alone does not reliably terminate its Windows children.
        & "$env:SystemRoot\System32\taskkill.exe" /PID $process.Id /T /F 2>&1 | Out-Null
        Write-Output '{"success":false,"error":{"code":"timeout","message":"Helper operation timed out or was stopped. Original files are retained."}}'
        exit 1
      }
    }
    [Console]::Out.Write($stdout.GetAwaiter().GetResult())
    [Console]::Error.Write($stderr.GetAwaiter().GetResult())
    exit $process.ExitCode
} catch {
    [Console]::Error.WriteLine($_)
    Write-Output '{"success":false,"error":{"code":"helper_unavailable","message":"Could not launch Windows dotnet. Check Windows .NET 8 Desktop runtime and helper files."}}'
    exit 1
}
