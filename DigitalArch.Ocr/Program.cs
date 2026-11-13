using System.Diagnostics;
using System.Text.Json;

// NAPS2 1.6.0 accepts a custom executable, but exposes no PSM argument.
// This bounded adapter forwards its hOCR invocation to the same Tesseract binary.
try
{
    var executable = Environment.GetEnvironmentVariable("DIGITALARCH_OCR_EXECUTABLE");
    var mode = Environment.GetEnvironmentVariable("DIGITALARCH_OCR_PSM");
    var metrics = Environment.GetEnvironmentVariable("DIGITALARCH_OCR_METRICS");
    if (executable == null || !Path.IsPathFullyQualified(executable) || !File.Exists(executable) ||
        !new[] { "3", "4", "6" }.Contains(mode) || metrics == null || !Path.IsPathFullyQualified(metrics))
        throw new InvalidOperationException();
    var start = new ProcessStartInfo(executable) { UseShellExecute=false, CreateNoWindow=true, RedirectStandardOutput=true, RedirectStandardError=true };
    foreach (var arg in args) start.ArgumentList.Add(arg);
    start.ArgumentList.Add("--psm"); start.ArgumentList.Add(mode!);
    start.ArgumentList.Add("--dpi"); start.ArgumentList.Add("300");
    using var process = Process.Start(start) ?? throw new InvalidOperationException();
    process.PriorityClass = ProcessPriorityClass.BelowNormal;
    var stdout = process.StandardOutput.ReadToEndAsync();
    var stderr = process.StandardError.ReadToEndAsync();
    long peak=0;
    var exit=process.WaitForExitAsync();
    while(!exit.IsCompleted) {
      try {process.Refresh();peak=Math.Max(peak,process.PeakWorkingSet64);} catch(InvalidOperationException) { }
      await Task.WhenAny(exit,Task.Delay(25));
    }
    await exit;
    await stdout; await stderr;
    await File.WriteAllTextAsync(metrics,JsonSerializer.Serialize(new { peakWorkingSetBytes=peak, exitCode=process.ExitCode }));
    if (process.ExitCode != 0) Console.Error.WriteLine("Tesseract exited unsuccessfully.");
    Environment.ExitCode=process.ExitCode;
}
catch { Console.Error.WriteLine("OCR adapter failed."); Environment.ExitCode=1; }
