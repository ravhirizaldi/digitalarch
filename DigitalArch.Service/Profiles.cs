using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Xml;
using System.Xml.Linq;

namespace DigitalArch;

public record ProfileSettings(string PaperSource, string PageSize, int Dpi, string ColorMode, string PageAlign);
public record ScannerProfile(string Id, string Name, string Source, string Driver, string? DeviceId,
    string DeviceName, ProfileSettings Settings, bool Compatible, string[] Limitations);
public record ProfileResult(List<ScannerProfile> Profiles, List<string> Warnings);

public static class Profiles
{
    public static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    public static readonly ScannerProfile Default = new("digitalarch-default", "Brother ADS-2400N (Default)",
        "digitalarch", "Wia", null, "Brother ADS-2400N", new("Feeder", "Letter", 300, "Color", "Right"), true, []);

    public static ProfileResult Read(string filename)
    {
        var result = new ProfileResult([], []);
        if (!File.Exists(filename)) { result.Warnings.Add("No native NAPS2 profile file found. DigitalArch default remains available."); return result; }
        try
        {
            using var reader = XmlReader.Create(filename, new XmlReaderSettings
            {
                DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, MaxCharactersInDocument = 2_000_000
            });
            var document = XDocument.Load(reader);
            if (document.Root?.Name.LocalName != "ArrayOfScanProfile") throw new XmlException("Unsupported root.");
            var index = 0;
            foreach (var node in document.Root.Elements("ScanProfile"))
            {
                string Get(string name) => node.Element(name)?.Value.Trim() ?? "";
                var limitations = new List<string>();
                var driver = Get("DriverName").ToLowerInvariant() == "wia" ? "Wia" : Get("DriverName");
                if (driver != "Wia") limitations.Add("Only Windows WIA profiles are supported; TWAIN is not enabled.");
                if (Get("Version") != "2") limitations.Add("Only the observed NAPS2 profile schema version 2 is supported.");
                var source = Get("PaperSource");
                var size = Get("PageSize");
                var align = Get("PageAlign");
                var color = Get("BitDepth") switch { "C24Bit" => "Color", "Grayscale" => "Grayscale", "BlackWhite" => "BlackAndWhite", _ => "Unsupported" };
                if (!int.TryParse(Get("Resolution").Replace("Dpi", ""), out var dpi) || dpi < 1 || dpi > 9600)
                    limitations.Add("Unsupported resolution.");
                if (source is not ("Feeder" or "Duplex")) limitations.Add("Only feeder or duplex paper sources are supported.");
                if (size is not ("Letter" or "Legal" or "A4" or "A5")) limitations.Add("Unsupported page size; custom sizes are not imported.");
                if (align is not ("Left" or "Center" or "Right")) limitations.Add("Unsupported page alignment.");
                if (color == "Unsupported") limitations.Add("Unsupported color mode.");
                // Ignore only observed metadata or explicitly neutral settings. Never silently import processing rules.
                var metadata = new HashSet<string> { "Version", "Device", "Caps", "DriverName", "DisplayName", "IconID", "IsDefault",
                    "PaperSource", "PageSize", "Resolution", "BitDepth", "PageAlign", "CustomPageSizeName", "CustomPageSize",
                    "AutoSaveSettings", "BlankPageWhiteThreshold", "BlankPageCoverageThreshold", "WiaDelayBetweenScansSeconds" };
                var neutral = new Dictionary<string, string>
                {
                    ["MaxQuality"] = "false", ["UseNativeUI"] = "false", ["AfterScanScale"] = "OneToOne",
                    ["Brightness"] = "0", ["Contrast"] = "0", ["EnableAutoSave"] = "false", ["Quality"] = "75",
                    ["AutoDeskew"] = "false", ["AutoCrop"] = "false", ["DocumentCorrection"] = "false",
                    ["RotateDegrees"] = "0", ["BrightnessContrastAfterScan"] = "false", ["ForcePageSize"] = "false",
                    ["ForcePageSizeCrop"] = "false", ["TwainImpl"] = "Default", ["TwainProgress"] = "false",
                    ["AppleImpl"] = "Default", ["ExcludeBlankPages"] = "false", ["WiaOffsetWidth"] = "false",
                    ["WiaRetryOnFailure"] = "false", ["WiaDelayBetweenScans"] = "false", ["WiaVersion"] = "Default",
                    ["FlipDuplexedPages"] = "false", ["KeyValueOptions"] = ""
                };
                foreach (var field in node.Elements())
                {
                    var name = field.Name.LocalName;
                    if (metadata.Contains(name))
                    {
                        if (name is "CustomPageSize" or "AutoSaveSettings" && !string.IsNullOrWhiteSpace(field.Value))
                            limitations.Add($"{name} is not supported.");
                        continue;
                    }
                    if (!neutral.TryGetValue(name, out var expected) || field.Value.Trim() != expected)
                        limitations.Add($"{name} is not applied by this POC; this profile cannot be used unchanged.");
                }
                var deviceName = node.Element("Device")?.Element("Name")?.Value ?? "";
                var deviceId = node.Element("Device")?.Element("ID")?.Value;
                if (string.IsNullOrWhiteSpace(deviceName)) limitations.Add("No device name configured.");
                var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(node.ToString(SaveOptions.DisableFormatting)))).ToLowerInvariant()[..16];
                result.Profiles.Add(new($"naps2-{index++}-{hash}", Get("DisplayName"), "naps2-desktop", driver, deviceId, deviceName,
                    new(source, size, dpi, color, align), limitations.Count == 0, limitations.ToArray()));
            }
        }
        catch (Exception error) when (error is XmlException or IOException or UnauthorizedAccessException)
        {
            result.Profiles.Clear();
            result.Warnings.Add("Native profile XML could not be read safely or uses an unsupported schema. DigitalArch default remains available.");
        }
        return result;
    }
}
