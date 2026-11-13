using System.Text.Json;
using DigitalArch;
using NAPS2.Images;
using NAPS2.Images.Gdi;
using NAPS2.Scan;

void Emit(object value) => Console.WriteLine(JsonSerializer.Serialize(value, Profiles.Json));
string? Option(string flag)
{
    var index = Array.IndexOf(args, flag);
    return index >= 0 && index + 1 < args.Length ? args[index + 1] : null;
}
string ProfileFile() => Option("--profile-file") ?? Environment.GetEnvironmentVariable("DIGITALARCH_NAPS2_PROFILES")
    ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "NAPS2", "profiles.xml");
var inspect = args.Contains("--inspect");
var devices = new List<ScanDevice>();
ProfileResult? inventory = null;
void EmitInspection(object probe) => Emit(new { success = true,
    devices = devices.Select(d => new { id = d.ID, d.Name, driver = "Wia" }),
    profiles = inventory!.Profiles, warnings = inventory.Warnings, probe });

try
{
    if (args.Contains("--ocr") || args.Contains("--ocr-info"))
    {
        await Ocr.Run(args);
        return;
    }
    if (args.Contains("--profiles"))
    {
        var catalog = Profiles.Read(ProfileFile());
        Emit(new { success = true, catalog.Profiles, catalog.Warnings });
        return;
    }
    if (!OperatingSystem.IsWindows()) throw new CliFailure("helper_unavailable", "Windows dotnet is required for WIA.");
    using var context = new ScanningContext(new GdiImageContext());
    var controller = new ScanController(context);
    using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(args.Contains("--scan") || args.Length == 1 && !args[0].StartsWith("--") ? 590 : 20));
    await foreach (var device in controller.GetDevices(Driver.Wia, timeout.Token)) devices.Add(device);
    if (args.Contains("--devices") || args.Contains("--list"))
    {
        Emit(new { success = true, driver = "Wia", devices = devices.Select(d => new { id = d.ID, d.Name, driver = "Wia" }) });
        return;
    }
    var profiles = Profiles.Read(ProfileFile());
    inventory = profiles;
    var profileId = Option("--profile") ?? Profiles.Default.Id;
    var profile = profileId == Profiles.Default.Id ? Profiles.Default : profiles.Profiles.SingleOrDefault(p => p.Id == profileId)
        ?? throw new CliFailure("invalid_profile", "Selected profile was not found.");
    if (!profile.Compatible) throw new CliFailure("unsupported_profile", "The native profile contains unsupported settings. Use a compatible profile.");
    var selectedId = Option("--device");
    var exact = devices.Where(d => profile.DeviceId != null && d.ID == profile.DeviceId).ToList();
    var candidates = exact.Count > 0 ? exact : devices.Where(d => d.Name == profile.DeviceName).ToList();
    if (selectedId != null) candidates = devices.Where(d => d.ID == selectedId && (d.ID == profile.DeviceId || d.Name == profile.DeviceName)).ToList();
    if (candidates.Count == 0) throw new CliFailure("device_not_found", "The configured scanner is not currently available through Windows WIA.");
    if (candidates.Count > 1) throw new CliFailure("ambiguous_device", "Multiple matching devices were found. Select an explicit device.");
    var scanner = candidates.Single();
    var settings = profile.Settings;
    var options = new ScanOptions
    {
        Device = scanner,
        PaperSource = settings.PaperSource == "Duplex" ? PaperSource.Duplex : PaperSource.Feeder,
        PageSize = settings.PageSize switch { "A4" => PageSize.A4, "A5" => PageSize.A5, "Legal" => PageSize.Legal, _ => PageSize.Letter },
        Dpi = settings.Dpi,
        BitDepth = settings.ColorMode switch { "Grayscale" => BitDepth.Grayscale, "BlackAndWhite" => BitDepth.BlackAndWhite, _ => BitDepth.Color },
        PageAlign = Enum.Parse<HorizontalAlign>(settings.PageAlign),
        ExcludeBlankPages = false
    };
    object? capsSummary = null;
    try
    {
        var caps = await controller.GetCaps(scanner, timeout.Token);
        var source = settings.PaperSource == "Duplex" ? caps.DuplexCaps : caps.FeederCaps;
        if (caps.PaperSourceCaps != null && !(settings.PaperSource == "Duplex" ? caps.PaperSourceCaps.SupportsDuplex : caps.PaperSourceCaps.SupportsFeeder))
            throw new CliFailure("unsupported_settings", "The scanner does not support this paper source.");
        if (source?.DpiCaps?.Values is { } dpiValues && !dpiValues.Contains(options.Dpi))
            throw new CliFailure("unsupported_settings", "The scanner does not support the selected resolution.");
        if (source?.PageSizeCaps is { } pageCaps && !pageCaps.Fits(options.PageSize))
            throw new CliFailure("unsupported_settings", "The page size exceeds the reported scan area.");
        if (source?.BitDepthCaps is { } colorCaps && !(options.BitDepth switch
            { BitDepth.Color => colorCaps.SupportsColor, BitDepth.Grayscale => colorCaps.SupportsGrayscale, _ => colorCaps.SupportsBlackAndWhite }))
            throw new CliFailure("unsupported_settings", "The scanner does not support this color mode.");
        if (caps.PaperSourceCaps != null || source != null)
            capsSummary = new { sources = caps.PaperSourceCaps, dpi = source?.DpiCaps?.Values,
                scanArea = source?.PageSizeCaps?.ScanArea, color = source?.BitDepthCaps };
        if (capsSummary == null && profile.Id != Profiles.Default.Id)
            throw new CliFailure("capabilities_unavailable", "Scanner detected, but no profile capability evidence was returned. Use Refresh or the DigitalArch default.");
    }
    catch (CliFailure) { throw; }
    catch (Exception)
    {
        // Capability queries are extra evidence; preserve the previously proven fallback scan path.
        if (profile.Id != Profiles.Default.Id)
            throw new CliFailure("capabilities_unavailable", "Scanner detected, but profile capabilities could not be verified. Try Refresh or use DigitalArch default.");
    }
    if (args.Contains("--probe") || inspect)
    {
        var probe = new { success = true, state = capsSummary == null ? "device_detected" : "capabilities_verified", canScan = true,
            device = new { id = scanner.ID, scanner.Name, driver = "Wia" }, capabilities = capsSummary,
            message = capsSummary == null ? "Scanner detected through WIA; capabilities unavailable. Physical scan readiness has not been verified."
                : "Available scanner capabilities verified through WIA; unreported settings cannot be checked. Physical scan readiness and paper availability have not been verified." };
        if (inspect) EmitInspection(probe); else Emit(probe);
        return;
    }
    var outputArgument = Option("--output") ?? (args.Length == 1 && !args[0].StartsWith("--") ? args[0] : null)
        ?? throw new CliFailure("invalid_request", "Use --devices, --profiles, --probe, or --scan --output filename.png.");
    var output = Path.GetFullPath(outputArgument);
    if (!output.EndsWith(".png", StringComparison.OrdinalIgnoreCase)) throw new CliFailure("invalid_request", "Output must be PNG.");
    var count = 0;
    await foreach (var image in controller.Scan(options, timeout.Token))
    {
        using (image)
        {
            var page = Path.Combine(Path.GetDirectoryName(output)!, $"{Path.GetFileNameWithoutExtension(output)}-{count + 1:000}.png");
            if (File.Exists(page)) throw new CliFailure("output_exists", "Refusing to overwrite a saved page.");
            var temporary = page + ".partial.png";
            if (File.Exists(temporary)) throw new CliFailure("output_exists", "Refusing to overwrite a partial page.");
            image.Save(temporary);
            if (!File.Exists(temporary) || new FileInfo(temporary).Length == 0) throw new IOException("Empty scan output.");
            File.Move(temporary, page);
            count++;
            Emit(new { type = "page", pageNumber = count, filename = Path.GetFileName(page) });
        }
    }
    if (count == 0) throw new CliFailure("empty_feeder", "No pages were captured. Load the feeder and try again.");
    Emit(new { success = true, type = "complete", pages = count });
}
catch (Exception error)
{
    var code = error is CliFailure cli ? cli.Code : error.GetType().Name switch
    {
        "DeviceFeederEmptyException" => "empty_feeder", "DevicePaperJamException" => "paper_jam",
        "DeviceOfflineException" or "DeviceNotFoundException" => "device_not_found",
        "DeviceCommunicationException" => "device_disconnected", "DeviceBusyException" => "device_busy",
        "NoFeederSupportException" or "NoDuplexSupportException" => "unsupported_settings",
        "OperationCanceledException" => "timeout",
        "IOException" or "UnauthorizedAccessException" => "output_error", _ => "driver_error"
    };
    var message = error is CliFailure ? error.Message : code switch
    {
        "empty_feeder" => "The feeder is empty. Load sheets and try again.",
        "paper_jam" => "Scanner paper jam. Clear the feeder; captured pages are retained.",
        "device_not_found" => "The scanner is offline or no longer available. Reconnect it and refresh.",
        "device_disconnected" => "The connection to the scanner was interrupted. Captured pages are retained.",
        "device_busy" => "The scanner is busy with another operation. Wait, then refresh.",
        "unsupported_settings" => "The scanner does not support the requested feeder or duplex settings.",
        "timeout" => "Scanner operation timed out. Check the scanner before retrying.",
        "output_error" => "Could not save scan output. Check disk space and directory permissions.",
        _ => "Windows WIA operation failed. Check scanner power, connection, and driver. Saved pages are retained."
    };
    Console.Error.WriteLine(error);
    var failure = new { success = false, error = new { code, message } };
    if (inspect && inventory != null) EmitInspection(failure);
    else { Emit(failure); Environment.ExitCode = 1; }
}

class CliFailure(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}
