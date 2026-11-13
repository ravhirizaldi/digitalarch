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
