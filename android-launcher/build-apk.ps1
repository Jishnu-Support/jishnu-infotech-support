$ErrorActionPreference = "Stop"

$projectRoot = $PSScriptRoot
$repoRoot = Split-Path -Parent $projectRoot
$sdkRoot = if ($env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT } else { Join-Path $env:LOCALAPPDATA "Android\Sdk" }
$platform = Join-Path $sdkRoot "platforms\android-36"
$buildTools = Join-Path $sdkRoot "build-tools\36.1.0"
$androidJarSource = Join-Path $platform "android.jar"
$aapt = Join-Path $buildTools "aapt.exe"
$d8Jar = Join-Path $buildTools "lib\d8.jar"
$apksignerJar = Join-Path $buildTools "lib\apksigner.jar"
$zipalign = Join-Path $buildTools "zipalign.exe"
$buildRoot = Join-Path $projectRoot "build"
$androidJar = Join-Path $buildRoot "android.jar"
$classDir = Join-Path $buildRoot "classes"
$dexDir = Join-Path $buildRoot "dex"
$keystore = Join-Path $buildRoot "jishnu-support-launcher.jks"
$passwordFile = Join-Path $buildRoot "signing-password.dpapi"
$sourceFile = Join-Path $projectRoot "src\com\jishnuinfotech\supportlauncher\MainActivity.java"
$manifest = Join-Path $projectRoot "AndroidManifest.xml"
$resources = Join-Path $projectRoot "res"
$baseApk = Join-Path $buildRoot "unsigned.apk"
$alignedApk = Join-Path $buildRoot "aligned.apk"
$outputApk = Join-Path $repoRoot "JishnuInfotechSupport.apk"

foreach ($requiredPath in @($androidJarSource, $aapt, $d8Jar, $apksignerJar, $zipalign, $sourceFile, $manifest)) {
  if (-not (Test-Path -LiteralPath $requiredPath)) { throw "Required Android build file not found: $requiredPath" }
}

New-Item -ItemType Directory -Path $classDir, $dexDir -Force | Out-Null
Copy-Item -LiteralPath $androidJarSource -Destination $androidJar -Force

$javaBin = Join-Path $env:ProgramFiles "Android\Android Studio\jbr\bin"
if (-not (Test-Path -LiteralPath (Join-Path $javaBin "javac.exe"))) {
  $javaBin = Split-Path -Parent (Get-Command javac -ErrorAction Stop).Source
}
$javac = Join-Path $javaBin "javac.exe"
$java = Join-Path $javaBin "java.exe"
$jar = Join-Path $javaBin "jar.exe"
$keytool = Join-Path $javaBin "keytool.exe"
foreach ($tool in @($javac, $java, $jar, $keytool)) {
  if (-not (Test-Path -LiteralPath $tool)) { throw "Java build tool not found: $tool" }
}

& $javac -Xlint:-options -source 8 -target 8 -bootclasspath $androidJar -d $classDir $sourceFile
if ($LASTEXITCODE -ne 0) { throw "Java compilation failed with exit code $LASTEXITCODE." }

$classFile = Join-Path $classDir "com\jishnuinfotech\supportlauncher\MainActivity.class"
& $java -cp $d8Jar com.android.tools.r8.D8 --lib $androidJar --min-api 23 --output $dexDir $classFile
if ($LASTEXITCODE -ne 0) { throw "DEX compilation failed with exit code $LASTEXITCODE." }

& $aapt package -f -M $manifest -S $resources -I $androidJar --min-sdk-version 23 --target-sdk-version 35 --version-code 1 --version-name 1.0 -F $baseApk
if ($LASTEXITCODE -ne 0) { throw "Android resource packaging failed with exit code $LASTEXITCODE." }

& $jar uf $baseApk -C $dexDir classes.dex
if ($LASTEXITCODE -ne 0) { throw "Adding the DEX file failed with exit code $LASTEXITCODE." }

& $zipalign -f 4 $baseApk $alignedApk
if ($LASTEXITCODE -ne 0) { throw "APK alignment failed with exit code $LASTEXITCODE." }

if (-not (Test-Path -LiteralPath $passwordFile)) {
  $random = [byte[]]::new(32)
  $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $generator.GetBytes($random)
  $generator.Dispose()
  $signingPassword = [Convert]::ToBase64String($random).TrimEnd("=").Replace("+", "-").Replace("/", "_")
  [IO.File]::WriteAllText($passwordFile, $signingPassword)
} else {
  $signingPassword = [IO.File]::ReadAllText($passwordFile)
}

if (-not (Test-Path -LiteralPath $keystore)) {
  & $keytool -genkeypair -noprompt -keystore $keystore -storepass $signingPassword -keypass $signingPassword -alias jishnu-support-launcher -dname "CN=Jishnu Infotech Support, O=Jishnu Infotech" -validity 10000 -keyalg RSA -keysize 2048
  if ($LASTEXITCODE -ne 0) { throw "Signing key creation failed with exit code $LASTEXITCODE." }
}

& $java -jar $apksignerJar sign --v4-signing-enabled false --ks $keystore --ks-key-alias jishnu-support-launcher --ks-pass "pass:$signingPassword" --key-pass "pass:$signingPassword" --out $outputApk $alignedApk
if ($LASTEXITCODE -ne 0) { throw "APK signing failed with exit code $LASTEXITCODE." }

& $java -jar $apksignerJar verify --verbose $outputApk
if ($LASTEXITCODE -ne 0) { throw "APK signature verification failed with exit code $LASTEXITCODE." }

Write-Host "APK created and signed: $outputApk" -ForegroundColor Green
Write-Host "Keep $buildRoot backed up to preserve the signing identity for compatible updates."
