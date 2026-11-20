package com.deepseek.chatdemo;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import java.io.IOException;

/**
 * 唯一界面：一个全屏 WebView，页面由内置的本机 HTTP 服务提供。
 *
 * 不用 file:// 的原因见 LocalServer：opaque origin 会让密码学接口、本地存储和官方登录回跳都失效。
 */
public class MainActivity extends Activity {

    private static final int REQUEST_FILE_CHOOSER = 1001;
    private static final int REQUEST_MICROPHONE = 1002;
    /** 唯一允许留在 WebView 内的外部主机：官方登录页 */
    private static final String AUTH_HOST = "platform.deepseek.com";

    private LocalServer server;
    private WebView web;
    private ValueCallback<Uri[]> pendingFileChooser;
    private int appTopInsetCssPixels;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        try {
            // 静态文件来自 assets/www；路径分隔符此处补上，Source 只接收以 / 开头的路径
            server = new LocalServer(path -> getAssets().open("www" + path));
        } catch (IOException unavailable) {
            // 端口完全不可用时没有可用的页面承载方式，直接结束
            finish();
            return;
        }

        web = new WebView(this);
        configure(web);
        // targetSdk 35+ 强制边到边，页面会画到状态栏下面；
        // 这里按系统栏 insets 给 WebView 让出空间，并把背景设成页面底色避免露色带
        web.setBackgroundColor(isNightMode() ? 0xFF151517 : 0xFFFFFFFF);
        insetBySystemBars(web);
        setContentView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        web.loadUrl(server.origin() + "/");

        requestMicrophoneIfNeeded();
    }

    /** 当前系统是否处于深色模式；用于让 WebView 内边距区域的底色与页面一致 */
    private boolean isNightMode() {
        int mode = getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK;
        return mode == Configuration.UI_MODE_NIGHT_YES;
    }

    /**
     * 把状态栏、导航栏占用的空间变成 WebView 的内边距。
     * 另外在顶部多留一点间距：只踩在状态栏下沿会和官方 App 一样显得贴边。
     */
    private void insetBySystemBars(View view) {
        // 状态栏下方只留少量间距，让移动顶栏避开系统图标并保持紧凑。
        final int breathing = Math.round(4 * getResources().getDisplayMetrics().density);
        view.setOnApplyWindowInsetsListener((target, insets) -> {
            int left;
            int top;
            int right;
            int bottom;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                Insets bars = insets.getInsets(
                        WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                left = bars.left;
                top = bars.top;
                right = bars.right;
                bottom = bars.bottom;
            } else {
                left = insets.getSystemWindowInsetLeft();
                top = insets.getSystemWindowInsetTop();
                right = insets.getSystemWindowInsetRight();
                bottom = insets.getSystemWindowInsetBottom();
            }
            // 兜底：API 35+ 一定处于边到边，若系统没派发 insets，就直接按状态栏高度让位。
            // 较旧系统可能已由 decor 消费状态栏 inset，此时 WebView 内容本身从状态栏下方开始。
            if (top == 0 && Build.VERSION.SDK_INT >= Build.VERSION_CODES.VANILLA_ICE_CREAM) {
                top = statusBarHeight();
            }
            // Insets 即使已由 decor 消费，也始终给顶部悬浮控件留出 4dp 的间距。
            float density = getResources().getDisplayMetrics().density;
            int statusBarCssPixels = top > 0 ? Math.round(top / density) : 0;
            int breathingCssPixels = Math.round(breathing / density);
            appTopInsetCssPixels = statusBarCssPixels + breathingCssPixels;
            // WebView 的原生 padding 不会稳定地改变内部文档的绝对定位原点。
            // 侧栏按钮用 CSS 安全距离定位，系统栏的左右和底部仍由原生 padding 处理。
            target.setPadding(left, 0, right, bottom);
            applyAppTopInset();
            return insets;
        });
        view.requestApplyInsets();
    }

    /** 把系统栏安全距离传给页面，供顶边悬浮控件使用 */
    private void applyAppTopInset() {
        if (web == null) {
            return;
        }
        web.evaluateJavascript(
                "document.documentElement.style.setProperty('--app-native-top-inset', '"
                        + appTopInsetCssPixels + "px')",
                null);
    }

    /** 状态栏高度的常规取法；系统资源不存在时返回 0 */
    private int statusBarHeight() {
        int id = getResources().getIdentifier("status_bar_height", "dimen", "android");
        return id > 0 ? getResources().getDimensionPixelSize(id) : 0;
    }

    private void configure(WebView view) {
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        // 会话与附件原件存在 WebView 的 localStorage / IndexedDB 里
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        // 朗读需要播放音频；录音需要允许页面直接申请麦克风
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setUserAgentString(settings.getUserAgentString() + " ChatDemo/" + versionName());

        view.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView target, String url) {
                super.onPageFinished(target, url);
                if (url.startsWith(server.origin() + "/")) {
                    applyAppTopInset();
                }
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView target, WebResourceRequest request) {
                Uri uri = request.getUrl();
                // 本机服务与官方登录页留在 WebView 内，其余链接交给系统浏览器
                if (isInternalHost(uri.getHost())) {
                    return false;
                }
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (Exception ignored) {
                    // 没有可处理的应用时保持当前页面
                }
                return true;
            }
        });

        view.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView target, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (pendingFileChooser != null) {
                    pendingFileChooser.onReceiveValue(null);
                }
                pendingFileChooser = callback;
                try {
                    startActivityForResult(params.createIntent(), REQUEST_FILE_CHOOSER);
                } catch (Exception unsupported) {
                    pendingFileChooser = null;
                    return false;
                }
                return true;
            }

            @Override
            public void onPermissionRequest(PermissionRequest request) {
                // 麦克风只授予本应用自己的页面：外部页面即使被导航进来也拿不到录音能力
                if (!isLocalOrigin(request.getOrigin())) {
                    request.deny();
                    return;
                }
                for (String resource : request.getResources()) {
                    if (!PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) {
                        continue;
                    }
                    if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                        request.grant(new String[] { PermissionRequest.RESOURCE_AUDIO_CAPTURE });
                    } else {
                        request.deny();
                    }
                    return;
                }
                request.deny();
            }
        });
    }

    /** 内嵌页面只来自本机服务；官方登录页需要留在 WebView 里，回跳才会落回本机服务 */
    private static boolean isInternalHost(String host) {
        return "127.0.0.1".equals(host) || "localhost".equals(host) || AUTH_HOST.equals(host);
    }

    /** 请求方必须是本应用自己的页面：loopback、http、且端口等于当前服务端口 */
    private boolean isLocalOrigin(Uri origin) {
        if (origin == null || server == null) {
            return false;
        }
        if (!"http".equals(origin.getScheme())) {
            return false;
        }
        String host = origin.getHost();
        if (!"127.0.0.1".equals(host) && !"localhost".equals(host)) {
            return false;
        }
        return origin.getPort() == server.port();
    }

    private void requestMicrophoneIfNeeded() {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] { Manifest.permission.RECORD_AUDIO }, REQUEST_MICROPHONE);
        }
    }

    private String versionName() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Exception missing) {
            return "0.1.1";
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != REQUEST_FILE_CHOOSER) {
            super.onActivityResult(requestCode, resultCode, data);
            return;
        }
        if (pendingFileChooser == null) {
            return;
        }
        pendingFileChooser.onReceiveValue(
                WebChromeClient.FileChooserParams.parseResult(resultCode, data));
        pendingFileChooser = null;
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && web != null && web.canGoBack()) {
            web.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.loadUrl("about:blank");
            web.destroy();
            web = null;
        }
        if (server != null) {
            server.close();
            server = null;
        }
        super.onDestroy();
    }
}
