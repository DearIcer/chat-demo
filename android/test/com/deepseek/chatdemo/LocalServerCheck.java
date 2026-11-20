package com.deepseek.chatdemo;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Base64;

/**
 * 在 JVM 上验证 LocalServer：静态托管、SPA 回落、MIME、以及 /__auth 到 Platform 的反代。
 * 不进入 APK，仅用于构建期自检。
 */
public final class LocalServerCheck {

    private static int failures;

    public static void main(String[] args) throws Exception {
        Path dist = Paths.get(args.length > 0 ? args[0] : "../dist");
        if (!Files.isDirectory(dist)) {
            throw new IllegalStateException("找不到 dist 目录: " + dist.toAbsolutePath());
        }
        LocalServer server = new LocalServer(path -> Files.newInputStream(resolve(dist, path)));
        String origin = server.origin();
        System.out.println("server: " + origin);

        try {
            expectHtml(origin, "/", "<div id=\"root\">");
            expectHtml(origin, "/oauth/callback?code=abc&state=def", "<div id=\"root\">");
            expectHtml(origin, "/no-such-page", "<div id=\"root\">");
            expectCss(origin);
            expectRequestLimits(server.port());
            expectProxy(origin);
        } finally {
            server.close();
        }

        System.out.println(failures == 0 ? "\nALL CHECKS PASSED" : "\nFAILURES: " + failures);
        if (failures > 0) {
            System.exit(1);
        }
    }

    /** 把请求路径映射到磁盘文件，并挡住目录穿越 */
    private static Path resolve(Path root, String path) throws IOException {
        String clean = path.startsWith("/") ? path.substring(1) : path;
        if (clean.isEmpty()) {
            clean = "index.html";
        }
        Path resolved = root.resolve(clean).normalize();
        if (!resolved.startsWith(root.normalize())) {
            throw new IOException("path outside root: " + path);
        }
        if (!Files.isRegularFile(resolved)) {
            throw new IOException("missing: " + path);
        }
        return resolved;
    }

    private static void expectHtml(String origin, String path, String marker) throws IOException {
        Response response = get(origin + path);
        check(path + " -> 200", response.status == 200);
        check(path + " -> html content-type", response.contentType.startsWith("text/html"));
        check(path + " -> contains " + marker, response.body.contains(marker));
    }

    private static void expectCss(String origin) throws IOException {
        String css = firstFile(origin, "static/css/main.");
        check("main css exists", css != null);
        if (css == null) {
            return;
        }
        Response response = get(origin + "/" + css);
        check(css + " -> 200", response.status == 200);
        check(css + " -> text/css", response.contentType.startsWith("text/css"));
    }

    private static String firstFile(String origin, String prefix) throws IOException {
        Response index = get(origin + "/");
        int at = index.body.indexOf(prefix);
        if (at < 0) {
            return null;
        }
        int end = at;
        while (end < index.body.length() && index.body.charAt(end) != '"' && index.body.charAt(end) != '\'') {
            end++;
        }
        return index.body.substring(at, end);
    }

    /**
     * 本机服务的请求边界：超大声明长度、无法解析的长度、超长请求行都必须被拒绝，
     * 不能按攻击者给的长度分配内存。
     */
    private static void expectRequestLimits(int port) throws IOException {
        check("oversized content-length -> 413",
                rawStatus(port, "POST /__auth/auth-api/v0/dsh/auth_init HTTP/1.1\r\n"
                        + "Host: 127.0.0.1\r\nContent-Length: 2000000\r\n\r\n") == 413);
        check("unparsable content-length -> 400",
                rawStatus(port, "POST /__auth/x HTTP/1.1\r\nHost: h\r\nContent-Length: abc\r\n\r\n") == 400);
        check("negative content-length -> 400",
                rawStatus(port, "POST /__auth/x HTTP/1.1\r\nHost: h\r\nContent-Length: -5\r\n\r\n") == 400);

        StringBuilder longLine = new StringBuilder("GET /");
        for (int i = 0; i < 9000; i++) {
            longLine.append('a');
        }
        longLine.append(" HTTP/1.1\r\nHost: h\r\n\r\n");
        check("oversized request line -> 400", rawStatus(port, longLine.toString()) == 400);

        // 声明 100 字节却只发 10 字节就断开：不能把半截正文当成完整请求
        int incomplete = rawStatus(port, "POST /__auth/x HTTP/1.1\r\nHost: h\r\nContent-Length: 100\r\n\r\n0123456789");
        check("incomplete body is not served (" + incomplete + ")", incomplete == 0 || incomplete == 400);
    }

    /** 直接写原始请求，返回响应码；没有任何响应时返回 0 */
    private static int rawStatus(int port, String request) {
        try (Socket socket = new Socket("127.0.0.1", port)) {
            socket.setSoTimeout(5_000);
            OutputStream out = socket.getOutputStream();
            out.write(request.getBytes(StandardCharsets.ISO_8859_1));
            out.flush();
            socket.shutdownOutput();
            InputStream in = socket.getInputStream();
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            byte[] chunk = new byte[1024];
            int read;
            while ((read = in.read(chunk)) != -1) {
                buffer.write(chunk, 0, read);
                if (buffer.size() > 64 * 1024) {
                    break;
                }
            }
            String head = buffer.toString("ISO-8859-1");
            if (!head.startsWith("HTTP/1.1 ")) {
                return 0;
            }
            return Integer.parseInt(head.substring(9, 12));
        } catch (IOException closed) {
            return 0;
        }
    }

    /** /__auth 必须真的打到 Platform，并返回可解析的业务信封；限流（429）视为链路可用但不判定成功 */
    private static void expectProxy(String origin) throws Exception {
        String verifier = base64Url(random(32));
        String challenge = base64Url(MessageDigest.getInstance("SHA-256")
                .digest(verifier.getBytes(StandardCharsets.US_ASCII)));
        String state = base64Url(random(32));
        String body = "{"
                + "\"code_challenge\":\"" + challenge + "\","
                + "\"code_challenge_method\":\"S256\","
                + "\"state\":\"" + state + "\","
                + "\"redirect_uri\":\"http://127.0.0.1:47113/oauth/callback\","
                + "\"locale\":\"zh_CN\","
                + "\"login_source\":\"web\""
                + "}";

        Response response = null;
        for (int attempt = 1; attempt <= 3; attempt++) {
            response = post(origin + "/__auth/auth-api/v0/dsh/auth_init", body);
            if (response.status != 429) {
                break;
            }
            System.out.println("  ..    upstream rate limited (429), retry " + attempt + "/3");
            Thread.sleep(20_000);
        }

        check("proxy reachable", response != null && response.status != 0);
        if (response == null) {
            return;
        }
        check("proxy -> upstream status passed through (" + response.status + ")",
                response.status == 200 || response.status == 429);
        if (response.status == 429) {
            System.out.println("  note  upstream rate limited; proxy plumbing verified, payload check skipped");
            return;
        }
        check("proxy -> 200", response.status == 200);
        check("proxy -> code 0", response.body.contains("\"code\":0"));
        check("proxy -> authorize_url", response.body.contains("authorize_url"));
        check("proxy -> official host", response.body.contains("platform.deepseek.com"));
        System.out.println("proxy payload: " + response.body.substring(0, Math.min(response.body.length(), 220)) + "...");
    }

    private static Response post(String url, String body) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setRequestMethod("POST");
        connection.setDoOutput(true);
        connection.setConnectTimeout(20_000);
        connection.setReadTimeout(30_000);
        connection.setRequestProperty("content-type", "application/json");
        connection.setRequestProperty("x-client-platform", "web");
        connection.setRequestProperty("x-client-bundle-id", "");
        connection.setRequestProperty("x-client-version", "0.1.1");
        connection.setRequestProperty("x-client-locale", "zh_CN");
        connection.setRequestProperty("x-client-timezone-offset", "28800");
        try (OutputStream out = connection.getOutputStream()) {
            out.write(body.getBytes(StandardCharsets.UTF_8));
        }
        int status = connection.getResponseCode();
        String type = connection.getContentType() == null ? "" : connection.getContentType();
        InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
        String payload = stream == null ? "" : read(stream);
        connection.disconnect();
        return new Response(status, type, payload);
    }

    private static Response get(String url) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setRequestProperty("accept", "*/*");
        connection.setConnectTimeout(10_000);
        connection.setReadTimeout(20_000);
        int status = connection.getResponseCode();
        String type = connection.getContentType() == null ? "" : connection.getContentType();
        InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
        String body = stream == null ? "" : read(stream);
        connection.disconnect();
        return new Response(status, type, body);
    }

    private static String read(InputStream input) throws IOException {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        byte[] chunk = new byte[8192];
        int read;
        while ((read = input.read(chunk)) != -1) {
            buffer.write(chunk, 0, read);
        }
        input.close();
        return new String(buffer.toByteArray(), StandardCharsets.UTF_8);
    }

    private static byte[] random(int size) {
        byte[] bytes = new byte[size];
        new SecureRandom().nextBytes(bytes);
        return bytes;
    }

    private static String base64Url(byte[] bytes) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    private static void check(String label, boolean ok) {
        System.out.println((ok ? "  ok    " : "  FAIL  ") + label);
        if (!ok) {
            failures++;
        }
    }

    private static final class Response {
        final int status;
        final String contentType;
        final String body;

        Response(int status, String contentType, String body) {
            this.status = status;
            this.contentType = contentType;
            this.body = body;
        }
    }
}
