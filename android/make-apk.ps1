# 构建 chat-demo 的 APK。
#
# 不依赖 Gradle：直接用 SDK 里的 aapt2 / d8 / zipalign / apksigner 与 Android Studio 自带的 JDK。
# APK 内容 = aapt2 链接出的资源 + d8 生成的 classes.dex + assets/www 里的前端产物。
#
# 用法：powershell -File android\make-apk.ps1 [-SkipWebBuild]

param(
    [switch]$SkipWebBuild,
    # 额外在 JVM 上跑一遍 LocalServer 自检（会访问 Platform，可能被限流）
    [switch]$Check
)

# 原生命令向 stderr 写内容时，PowerShell 5.1 会生成错误记录；配合 Stop 会直接终止脚本。
# 因此这里保持 Continue，并逐个检查 $LASTEXITCODE；需要终止的地方显式 throw。
$ErrorActionPreference = 'Continue'
Set-Location (Split-Path -Parent $MyInvocation.MyCommand.Path)

function Assert-Exit {
    param([int]$Code, [string]$Message)
    if ($Code -ne 0) { throw $Message }
}

function Find-Sdk {
    $candidates = @(@(
        $env:ANDROID_HOME,
        $env:ANDROID_SDK_ROOT,
        "$env:LOCALAPPDATA\Android\Sdk",
        "C:\Android\Sdk"
    ) | Where-Object { $_ -and (Test-Path $_) })
    if ($candidates.Count -eq 0) { throw 'Android SDK 未找到，请设置 ANDROID_HOME' }
    return $candidates[0]
}

function Find-Jdk {
    $candidates = @(@(
        $env:JAVA_HOME,
        'C:\Program Files\Android\Android Studio\jbr',
        'C:\Program Files\Java\jdk-21',
        'C:\Program Files\Eclipse Adoptium\jdk-21'
    ) | Where-Object { $_ -and (Test-Path (Join-Path $_ 'bin\javac.exe')) })
    if ($candidates.Count -eq 0) { throw 'JDK 未找到，请设置 JAVA_HOME' }
    return $candidates[0]
}

$sdk = Find-Sdk
$jdk = Find-Jdk
$buildTools = Get-ChildItem (Join-Path $sdk 'build-tools') -Directory |
    Sort-Object { [version]$_.Name } -Descending |
    Select-Object -First 1
$platform = Get-ChildItem (Join-Path $sdk 'platforms') -Directory |
    Where-Object { Test-Path (Join-Path $_.FullName 'android.jar') } |
    Sort-Object Name -Descending |
    Select-Object -First 1
if (-not $buildTools) { throw 'build-tools 未找到' }
if (-not $platform) { throw 'platform 未找到' }

$aapt2 = Join-Path $buildTools.FullName 'aapt2.exe'
$zipalign = Join-Path $buildTools.FullName 'zipalign.exe'
$apksigner = Join-Path $buildTools.FullName 'apksigner.bat'
$d8 = Join-Path $buildTools.FullName 'd8.bat'
$javac = Join-Path $jdk 'bin\javac.exe'
$keytool = Join-Path $jdk 'bin\keytool.exe'
$androidJar = Join-Path $platform.FullName 'android.jar'
$env:JAVA_HOME = $jdk
$env:PATH = (Join-Path $jdk 'bin') + ';' + $env:PATH

Write-Host "SDK   : $sdk"
Write-Host "JDK   : $jdk"
Write-Host "tools : $($buildTools.Name) / $($platform.Name)"

# ---- 1) 前端产物 ----
if (-not $SkipWebBuild) {
    Push-Location '..'
    $env:NODE_ENV = 'production'
    & npx rspack build -c rspack.config.ts
    $webExit = $LASTEXITCODE
    $env:NODE_ENV = ''
    Pop-Location
    Assert-Exit $webExit '前端构建失败'
}
if (-not (Test-Path '..\dist\index.html')) { throw '缺少 dist/index.html，请先构建前端' }

# ---- 2) 清理并准备 intermediates ----
if (Test-Path 'build') { Remove-Item 'build' -Recurse -Force }
New-Item -ItemType Directory -Force -Path 'build' | Out-Null
$www = 'assets\www'
if (Test-Path 'assets') { Remove-Item 'assets' -Recurse -Force }
New-Item -ItemType Directory -Force -Path $www | Out-Null
Copy-Item '..\dist\*' $www -Recurse -Force

# ---- 3) 资源编译与链接 ----
& $aapt2 compile --dir res -o build\res.zip
Assert-Exit $LASTEXITCODE 'aapt2 compile 失败'

# 注意：不使用 aapt2 的 -A（Windows 下会把资源名写成反斜杠），assets 在打包阶段自行写入
& $aapt2 link -o build\base.apk -I $androidJar --manifest AndroidManifest.xml --java build\gen build\res.zip
Assert-Exit $LASTEXITCODE 'aapt2 link 失败'

# ---- 4) 编译 Java ----
$sources = @(Get-ChildItem 'src' -Recurse -Filter '*.java' | ForEach-Object { $_.FullName })
$sources += @(Get-ChildItem 'build\gen' -Recurse -Filter '*.java' | ForEach-Object { $_.FullName })
New-Item -ItemType Directory -Force -Path 'build\classes' | Out-Null
# 用 --release + classpath 定位 Android API：避免 -source/-target 与系统模块的告警
& $javac -encoding UTF-8 --release 11 -classpath $androidJar -d build\classes @sources
Assert-Exit $LASTEXITCODE 'javac 失败'

# ---- 5) 转 dex ----
$classes = @(Get-ChildItem 'build\classes' -Recurse -Filter '*.class' | ForEach-Object { $_.FullName })
& $d8 --release --lib $androidJar --min-api 26 --output build @classes
Assert-Exit $LASTEXITCODE 'd8 失败'

# ---- 5.5) 可选：在 JVM 上自检本机服务（静态托管 + /__auth 反代） ----
if ($Check) {
    New-Item -ItemType Directory -Force -Path 'build\check' | Out-Null
    & $javac -encoding UTF-8 --release 11 -d build\check @('src\com\deepseek\chatdemo\LocalServer.java', 'test\com\deepseek\chatdemo\LocalServerCheck.java')
    Assert-Exit $LASTEXITCODE 'javac（自检）失败'
    & (Join-Path $jdk 'bin\java.exe') -cp build\check com.deepseek.chatdemo.LocalServerCheck '..\dist'
    Assert-Exit $LASTEXITCODE 'LocalServer 自检未通过'
}

# ---- 6) 组装 APK：资源 + assets（正斜杠）+ classes.dex ----
# 用 JDK 的 java.util.zip 重打包：.NET Framework 的 ZipArchive 无法保证 resources.arsc 未压缩
New-Item -ItemType Directory -Force -Path 'build\tools' | Out-Null
& $javac -encoding UTF-8 --release 11 -d build\tools 'tools\ZipRepack.java'
Assert-Exit $LASTEXITCODE 'javac（ZipRepack）失败'
& (Join-Path $jdk 'bin\java.exe') -cp build\tools ZipRepack build\base.apk build\unsigned.apk build\classes.dex $www
Assert-Exit $LASTEXITCODE '组装 APK 失败'
# ---- 7) 对齐 ----
& $zipalign -p -f 4 build\unsigned.apk build\aligned.apk
Assert-Exit $LASTEXITCODE 'zipalign 失败'

# ---- 8) 签名（首次运行生成调试密钥） ----
$keystore = Join-Path (Get-Location) 'debug.keystore'
if (-not (Test-Path $keystore)) {
    & $keytool -genkeypair -keystore $keystore -alias androiddebugkey -storepass android -keypass android -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Android Debug,O=Android,C=US"
    Assert-Exit $LASTEXITCODE 'keytool 失败'
}

$final = Join-Path (Get-Location) 'chat-demo.apk'
if (Test-Path $final) { Remove-Item $final -Force }
& $apksigner sign --ks $keystore --ks-pass pass:android --key-pass pass:android --ks-key-alias androiddebugkey --out $final build\aligned.apk
Assert-Exit $LASTEXITCODE 'apksigner 失败'

& $apksigner verify --print-certs $final
Assert-Exit $LASTEXITCODE 'APK 签名校验失败'

# ---- 9) 产物校验：对齐、resources.arsc 未压缩、入口页存在 ----
& $zipalign -c -p 4 $final | Out-Null
Assert-Exit $LASTEXITCODE 'APK 未对齐'

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($final)
try {
    $arsc = $archive.Entries | Where-Object { $_.FullName -eq 'resources.arsc' }
    if (-not $arsc -or $arsc.CompressedLength -ne $arsc.Length) {
        throw 'resources.arsc 必须未压缩存储（targetSdk 30+）'
    }
    if (-not ($archive.Entries | Where-Object { $_.FullName -eq 'assets/www/index.html' })) {
        throw 'APK 缺少 assets/www/index.html'
    }
} finally {
    $archive.Dispose()
}

$size = [math]::Round((Get-Item $final).Length / 1MB, 2)
Write-Host ""
Write-Host "APK 生成：$final ($size MB)"
