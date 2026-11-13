using System.Diagnostics;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using NAPS2.Images.Gdi;
using NAPS2.Ocr;
using NAPS2.Scan;

namespace DigitalArch;

public static class Ocr
{
    public static async Task Run(string[] args)
    {
        string? Option(string flag) { var i = Array.IndexOf(args, flag); return i >= 0 && i+1 < args.Length ? args[i+1] : null; }
        void Emit(object value) => Console.WriteLine(JsonSerializer.Serialize(value, Profiles.Json));
        var temporary = Path.Combine(Path.GetTempPath(), "DigitalArch-OCR-" + Guid.NewGuid());
        try
        {
            if (!OperatingSystem.IsWindows()) throw new CliFailure("ocr_unavailable", "OCR requires the existing Windows .NET 8 runtime.");
            var language = Option("--language") ?? "ind+eng";
            if (!new[] { "ind", "eng", "ind+eng", "eng+ind" }.Contains(language)) throw new CliFailure("invalid_request", "Unsupported OCR languages.");
            var executable = Option("--tesseract") ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "NAPS2", "lib", "_win64", "tesseract.exe");
            var quality = Option("--quality") ?? "best";
            if (!new[] { "fast", "best" }.Contains(quality)) throw new CliFailure("invalid_request", "OCR quality must be fast or best.");
            var dataRoot = Option("--tessdata") ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "NAPS2", "components", "tesseract4");
            var data = Path.Combine(dataRoot,quality);
            var psmOption=Option("--psm");
            var psm=psmOption==null ? 3 : int.TryParse(psmOption,out var parsedPsm) && new[]{3,4,6}.Contains(parsedPsm) ? parsedPsm : throw new CliFailure("invalid_request","PSM must be 3, 4 or 6.");
            if (!Path.IsPathFullyQualified(executable) || !File.Exists(executable)) throw new CliFailure("ocr_unavailable", "Tesseract executable is missing. Configure OCR_TESSERACT_PATH.");
            var languages = new Dictionary<string,string>();
            foreach (var code in language.Split('+'))
            {
                var resource = Path.Combine(data, code + ".traineddata");
                if (!File.Exists(resource) || new FileInfo(resource).Length == 0) throw new CliFailure("ocr_language_missing", $"Required OCR resource {code}.traineddata is missing. Configure OCR_TESSDATA_PATH; no language fallback is permitted.");
                using var stream = File.OpenRead(resource);
                languages[code] = Convert.ToHexString(await SHA256.HashDataAsync(stream)).ToLowerInvariant();
            }
            var start = new ProcessStartInfo(executable) { UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true };
            start.ArgumentList.Add("--version");
            using var versionProcess = Process.Start(start) ?? throw new CliFailure("ocr_unavailable", "Could not launch Tesseract.");
            var versionText = versionProcess.StandardOutput.ReadToEndAsync();
            var versionError = versionProcess.StandardError.ReadToEndAsync();
            await versionProcess.WaitForExitAsync();
            var versionOutput = await versionText + await versionError;
            var version = Regex.Match(versionOutput, @"tesseract\s+(\S+)").Groups[1].Value;
            if (versionProcess.ExitCode != 0 || string.IsNullOrEmpty(version)) throw new CliFailure("ocr_unavailable", "Could not determine the Tesseract version.");
            string executableHash;
            using (var binary = File.OpenRead(executable)) executableHash = Convert.ToHexString(await SHA256.HashDataAsync(binary)).ToLowerInvariant();
            var configuration = new Dictionary<string,object> { ["sdk"]="NAPS2.Sdk/1.6.0", ["executableSha256"]=executableHash, ["languageData"]=languages, ["mode"]=quality == "best" ? "Best" : "Fast", ["preprocessing"]="none", ["priority"]="low" };
            if(psmOption!=null) configuration["psm"]=psm;
            if(psmOption!=null) {
                var adapter=Path.Combine(AppContext.BaseDirectory,"DigitalArch.Ocr.exe");
                if(!File.Exists(adapter)) throw new CliFailure("ocr_unavailable","OCR executable adapter is missing. Rebuild the helper.");
                using var adapterFile=File.OpenRead(adapter);
                configuration["adapterSha256"]=Convert.ToHexString(await SHA256.HashDataAsync(adapterFile)).ToLowerInvariant();
                using var adapterAssembly=File.OpenRead(Path.Combine(AppContext.BaseDirectory,"DigitalArch.Ocr.dll"));
                configuration["adapterAssemblySha256"]=Convert.ToHexString(await SHA256.HashDataAsync(adapterAssembly)).ToLowerInvariant();
            }
            if (args.Contains("--ocr-info")) { Emit(new { success = true, engine = "Tesseract (NAPS2)", engineVersion = version, language, configuration }); return; }
            var file = Option("--image") ?? throw new CliFailure("invalid_request", "OCR requires a trusted PNG path.");
            if (!Path.IsPathFullyQualified(file) || !file.EndsWith(".png", StringComparison.OrdinalIgnoreCase) || !File.Exists(file)) throw new CliFailure("invalid_image", "OCR source PNG is unavailable.");
            string Hash() { using var stream = File.OpenRead(file); return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant(); }
            var checksum = Hash();
            if (checksum != Option("--sha256")) throw new CliFailure("image_changed", "OCR source checksum does not match the queued image.");
            if ((Option("--priority") ?? "low") != "low") throw new CliFailure("invalid_request", "Only low OCR priority is supported by this SDK integration.");
            Process.GetCurrentProcess().PriorityClass = ProcessPriorityClass.BelowNormal;
            var seconds = int.TryParse(Option("--timeout-seconds"), out var requested) && requested >= 1 && requested <= 600 ? requested : 120;
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(seconds));
            // Keep SDK hOCR output inside Node's disposable staging directory as well.
            temporary = Path.Combine(Path.GetDirectoryName(file)!, ".ocr-" + Guid.NewGuid());
            Directory.CreateDirectory(temporary);
            using var context = new ScanningContext(new GdiImageContext()) { TempFolderPath = temporary };
            // Never use WithPreProcess: that SDK mode overwrites the input image.
            var metrics=Path.Combine(temporary,"metrics.json");
            if(psmOption!=null) {
                Environment.SetEnvironmentVariable("DIGITALARCH_OCR_EXECUTABLE",executable);
                Environment.SetEnvironmentVariable("DIGITALARCH_OCR_PSM",psm.ToString());
                Environment.SetEnvironmentVariable("DIGITALARCH_OCR_METRICS",metrics);
            }
            var engine = TesseractOcrEngine.Custom(psmOption==null ? executable : Path.Combine(AppContext.BaseDirectory,"DigitalArch.Ocr.exe"), data);
            var timedOut = false;
            engine.OcrTimeout += (_, _) => timedOut = true;
            var watch = Stopwatch.StartNew();
            // The existing Windows wrapper bounds/kills the entire helper→adapter→Tesseract tree.
            var result = await engine.ProcessImage(context, file, new OcrParams(language, quality == "best" ? OcrMode.Best : OcrMode.Fast, psmOption==null?seconds:0), psmOption==null?timeout.Token:CancellationToken.None);
            if (result == null) throw new CliFailure(timedOut || timeout.IsCancellationRequested ? "ocr_timeout" : "ocr_failed", "Tesseract could not process the PNG. Check language resources and image integrity.");
            if (Hash() != checksum) throw new CliFailure("image_changed", "OCR source changed during processing.");
            object Bounds((int x,int y,int w,int h) b) => new { x=b.x, y=b.y, width=b.w, height=b.h };
            object Element(OcrResultElement e) => new { text=e.Text, language=e.LanguageCode, e.RightToLeft, bounds=Bounds(e.Bounds), e.Baseline, e.FontSize };
            long? peakMemory=null;
            if(File.Exists(metrics)) {using var measurement=JsonDocument.Parse(await File.ReadAllTextAsync(metrics));peakMemory=measurement.RootElement.GetProperty("peakWorkingSetBytes").GetInt64();}
            Emit(new { success = true, engine = "Tesseract (NAPS2)", engineVersion = version, language, configuration, peakWorkingSetBytes=peakMemory,
                imageSha256 = checksum, text = string.Join("\n", result.Lines.Select(line => line.Text)),
                structuredResult = new { coordinateSystem = "ocr-input-pixels", pageBounds = Bounds(result.PageBounds),
                    lines = result.Lines.Select(line => new { text=line.Text, bounds=Bounds(line.Bounds), words=line.Children.Select(Element) }) },
                processedAt = DateTimeOffset.UtcNow, processingMs = watch.ElapsedMilliseconds });
        }
        catch (Exception error)
        {
            var code = error is CliFailure cli ? cli.Code : "ocr_failed";
            // Document contents and paths do not belong in diagnostics.
            Console.Error.WriteLine("OCR helper: " + code);
            Emit(new { success = false, error = new { code, message = error is CliFailure ? error.Message : "OCR helper failed. Check image readability, runtime and Tesseract resources." } });
            Environment.ExitCode = 1;
        }
        finally
        {
            try { if (Directory.Exists(temporary)) Directory.Delete(temporary, true); }
            catch { Console.Error.WriteLine("OCR temporary cleanup failed; Node will remove the staging directory."); }
        }
    }
}
