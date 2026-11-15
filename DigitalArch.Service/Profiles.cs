using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Xml;
using System.Xml.Linq;

namespace DigitalArch;

public record ProfileSettings(string PaperSource, string PageSize, int Dpi, string ColorMode, string PageAlign);
public record ScannerProfile(string Id, string Name, string Source, string Driver, string? DeviceId,
    string DeviceName, ProfileSettings Settings, bool Compatible, string[] Limitations, bool IsDefault = false, string Revision = "");
public record ProfileResult(List<ScannerProfile> Profiles, List<string> Warnings)
{
    public List<string> Files { get; } = [];
    public bool Incomplete { get; set; }
}

public static class Profiles
{
    public static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    public static readonly ScannerProfile Default = new("digitalarch-default", "WIA feeder (application defaults)",
        "digitalarch", "Wia", null, "", new("Feeder", "Letter", 300, "Color", "Right"), true, [], false, "1");

    public static ProfileResult Discover(string? configuredFile, string userData, string sharedData)
    {
        var result = new ProfileResult([], []);
        var filenames = configuredFile != null ? new[] { configuredFile } : new[] {
            Path.Combine(userData, "NAPS2", "profiles.xml"), Path.Combine(sharedData, "NAPS2", "profiles.xml") };
        foreach (var filename in filenames.Distinct(StringComparer.OrdinalIgnoreCase))
        {
            if (configuredFile == null && !File.Exists(filename)) continue;
            var catalog = Read(filename);
            result.Profiles.AddRange(catalog.Profiles);
            result.Warnings.AddRange(catalog.Warnings);
            result.Files.AddRange(catalog.Files);
            result.Incomplete |= catalog.Incomplete;
        }
        if (result.Files.Count == 0 && result.Warnings.Count == 0)
            result.Warnings.Add("No native NAPS2 profile file found. Application defaults are available for a discovered WIA device.");
        return result;
    }

    public static ScannerProfile? Select(ProfileResult catalog, IEnumerable<(string Id, string Name)> devices)
    {
        if (catalog.Incomplete) return null;
        var defaults = catalog.Profiles.Where(p => p.IsDefault).ToList();
        if (defaults.Count == 1) return defaults[0];
        if (defaults.Count > 1) return null;
        var available = devices.ToList();
        var matched = catalog.Profiles.Where(p => p.Compatible &&
            (available.Count(d => p.DeviceId != null && d.Id == p.DeviceId) == 1 ||
             available.Count(d => d.Name == p.DeviceName) == 1)).ToList();
        if (matched.Count == 1) return matched[0];
        return catalog.Profiles.Count switch { 0 => Default, 1 => catalog.Profiles[0], _ => null };
    }

    public static ProfileResult Read(string filename)
    {
        var result = new ProfileResult([], []);
        if (!File.Exists(filename)) { result.Incomplete = true; result.Warnings.Add("No native NAPS2 profile file found. Application defaults remain available."); return result; }
        try
        {
            using var reader = XmlReader.Create(filename, new XmlReaderSettings
            {
                DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, MaxCharactersInDocument = 2_000_000
            });
            var document = XDocument.Load(reader);
            if (document.Root?.Name != "ArrayOfScanProfile" || document.Root.Elements().Any(node => node.Name != "ScanProfile"))
                throw new XmlException("Unsupported profile schema.");
            result.Files.Add(Path.GetFullPath(filename));
            var names = document.Root.Elements("ScanProfile").GroupBy(node => node.Element("DisplayName")?.Value.Trim() ?? "")
                .ToDictionary(group => group.Key, group => group.Count());
            var occurrences = new Dictionary<string, int>();
            foreach (var node in document.Root.Elements("ScanProfile"))
            {
                string Get(string name) => node.Element(name)?.Value.Trim() ?? "";
                var limitations = new List<string>();
                var profileName = Get("DisplayName");
                if (string.IsNullOrWhiteSpace(profileName)) limitations.Add("No profile name configured.");
                if (names[profileName] > 1) limitations.Add("Duplicate profile name; rename it in NAPS2 to select it safely.");
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
                string Hash(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant()[..24];
                var occurrence = occurrences.GetValueOrDefault(profileName);
                occurrences[profileName] = occurrence + 1;
                var id = Hash(Path.GetFullPath(filename).ToUpperInvariant() + "\n" + profileName + "\n" + occurrence);
                var revision = Hash(node.ToString(SaveOptions.DisableFormatting));
                result.Profiles.Add(new($"naps2-{id}", profileName, "naps2-desktop", driver, deviceId, deviceName,
                    new(source, size, dpi, color, align), limitations.Count == 0, limitations.ToArray(),
                    bool.TryParse(Get("IsDefault"), out var isDefault) && isDefault, revision));
            }
        }
        catch (Exception error) when (error is XmlException or IOException or UnauthorizedAccessException)
        {
            result.Profiles.Clear();
            result.Incomplete = true;
            result.Warnings.Add("Native profile XML could not be read safely or uses an unsupported schema. Application defaults remain available.");
        }
        return result;
    }
}
