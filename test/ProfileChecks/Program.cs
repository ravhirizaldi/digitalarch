using DigitalArch;
using System.Security.Cryptography;

var directory = Path.Combine(Path.GetTempPath(), "digitalarch-profile-checks-" + Guid.NewGuid());
Directory.CreateDirectory(directory);
var checks = 0;
void Check(bool condition, string name)
{
    if (!condition) throw new Exception("FAILED: " + name);
    checks++;
}
var filename = Path.Combine(directory, "profiles.xml");
string Profile(string extra = "", string id = "discovered-id") => $"""
<ScanProfile><Version>2</Version><DisplayName>Office scanner</DisplayName><Device><ID>{id}</ID><Name>Brother ADS-2400N</Name></Device>
<DriverName>wia</DriverName><PaperSource>Feeder</PaperSource><PageSize>Letter</PageSize><Resolution>Dpi300</Resolution>
<BitDepth>C24Bit</BitDepth><PageAlign>Right</PageAlign>{extra}</ScanProfile>
""";
ProfileResult Read(string xml)
{
    File.WriteAllText(filename, xml);
    var before = SHA256.HashData(File.ReadAllBytes(filename));
    var result = Profiles.Read(filename);
    Check(before.SequenceEqual(SHA256.HashData(File.ReadAllBytes(filename))), "native file stays byte-identical");
    return result;
}
try
{
    Check(Profiles.Read(filename).Profiles.Count == 0, "missing native profile is not fatal");
    Check(Profiles.Default.Source == "digitalarch" && Profiles.Default.Settings.Dpi == 300, "application fallback source and defaults");
    var good = Read("<ArrayOfScanProfile>" + Profile() + "</ArrayOfScanProfile>");
    Check(good.Profiles.Single().Compatible, "observed supported XML fields parsed");
    Check(good.Profiles.Single().DeviceId == "discovered-id", "actual configured device ID extracted");
    Check(good.Profiles.Single().Settings.PaperSource == "Feeder", "feeder preserved");
    Check(Profiles.Default.DeviceId == null && Profiles.Default.DeviceName == "", "application fallback is not bound to a scanner brand");
    var changed = Read(("<ArrayOfScanProfile>" + Profile() + "</ArrayOfScanProfile>").Replace("Dpi300", "Dpi600"));
    Check(changed.Profiles.Single().Id == good.Profiles.Single().Id, "profile identity survives a settings edit");
    Check(changed.Profiles.Single().Revision != good.Profiles.Single().Revision, "profile revision detects settings edits");
    var second = Profile(id: "another-device").Replace("Office scanner", "Second scanner");
    var ordered = Read("<ArrayOfScanProfile>" + Profile() + second + "</ArrayOfScanProfile>");
    var reordered = Read("<ArrayOfScanProfile>" + second + Profile() + "</ArrayOfScanProfile>");
    Check(ordered.Profiles.Single(p => p.Name == "Office scanner").Id == reordered.Profiles.Single(p => p.Name == "Office scanner").Id, "profile IDs do not depend on list ordering");
    var defaults = Read("<ArrayOfScanProfile>" + Profile("<IsDefault>true</IsDefault>") + second + "</ArrayOfScanProfile>");
    Check(Profiles.Select(defaults, [])?.Name == "Office scanner", "native default is preferred without silently changing its device");
    Check(Profiles.Select(ordered, [("discovered-id", "Any vendor")])?.Name == "Office scanner", "unique matched native profile is selected");
    Check(Profiles.Select(ordered, []) == null, "ambiguous profiles require selection");
    var duplicate = Read("<ArrayOfScanProfile>" + Profile() + Profile() + "</ArrayOfScanProfile>");
    Check(duplicate.Profiles.All(p => !p.Compatible) && duplicate.Profiles.Select(p => p.Id).Distinct().Count() == 2, "duplicate names remain visible and cannot be silently confused");
    Check(Profiles.Select(Read("<broken"), []) == null, "unreadable inventory cannot automatically switch to application defaults");
    Check(Profiles.Select(Read("<ArrayOfScanProfile xmlns='urn:unknown'>" + Profile() + "</ArrayOfScanProfile>"), []) == null, "unsupported namespaces cannot appear to be an empty inventory");
    var userData = Path.Combine(directory, "user");
    var sharedData = Path.Combine(directory, "shared");
    Directory.CreateDirectory(Path.Combine(userData, "NAPS2"));
    Directory.CreateDirectory(Path.Combine(sharedData, "NAPS2"));
    File.WriteAllText(Path.Combine(userData, "NAPS2", "profiles.xml"), "<ArrayOfScanProfile>" + Profile() + "</ArrayOfScanProfile>");
    File.WriteAllText(Path.Combine(sharedData, "NAPS2", "profiles.xml"), "<ArrayOfScanProfile>" + second + "</ArrayOfScanProfile>");
    var discovered = Profiles.Discover(null, userData, sharedData);
    Check(discovered.Profiles.Count == 2 && discovered.Files.Count == 2, "user and shared profiles are both discovered");
    Check(Profiles.Discover(Path.Combine(userData, "NAPS2", "profiles.xml"), userData, sharedData).Files.Count == 1, "explicit portable profile file overrides discovery locations");
    Check(Read(("<ArrayOfScanProfile>" + Profile() + "</ArrayOfScanProfile>").Replace("C24Bit", "Grayscale")).Profiles.Single().Settings.ColorMode == "Grayscale", "documented native Grayscale enum mapped");
    Check(Read("<ArrayOfScanProfile>" + Profile() + Profile(id: "missing-device") + "</ArrayOfScanProfile>").Profiles.Count == 2, "multiple profiles retained");
    Check(Read("<broken").Warnings.Count == 1, "malformed XML reported");
    Check(Read("<!DOCTYPE x [<!ENTITY file SYSTEM 'file:///etc/passwd'>]><ArrayOfScanProfile>&file;</ArrayOfScanProfile>").Profiles.Count == 0, "DTD and external entities rejected");
    foreach (var setting in new[] { "<AutoCrop>true</AutoCrop>", "<ExcludeBlankPages>true</ExcludeBlankPages>", "<UnrecognizedSetting>1</UnrecognizedSetting>", "<ForcePageSizeCrop>true</ForcePageSizeCrop>" })
    {
        var invalid = Read("<ArrayOfScanProfile>" + Profile(setting) + "</ArrayOfScanProfile>").Profiles.Single();
        Check(!invalid.Compatible && invalid.Limitations.Length > 0, "unsupported processing must not silently apply");
    }
    Check(Read(("<ArrayOfScanProfile>" + Profile() + "</ArrayOfScanProfile>").Replace("<DriverName>wia", "<DriverName>twain")).Profiles.Single().Compatible == false, "TWAIN not silently converted");
    Check(Read(("<ArrayOfScanProfile>" + Profile() + "</ArrayOfScanProfile>").Replace("<PaperSource>Feeder", "<PaperSource>Duplex")).Profiles.Single().Settings.PaperSource == "Duplex", "duplex profile source extracted");
    Console.WriteLine($"Passed {checks} profile assertions (no WIA or hardware).");
}
finally { Directory.Delete(directory, true); }
