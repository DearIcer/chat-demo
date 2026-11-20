package com.deepseek.chatdemo;

import java.io.ByteArrayOutputStream;
import java.io.Closeable;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 仅监听 127.0.0.1 的小型 HTTP 服务。
 *
 * 存在的理由：WebView 用 file:// 打开时是 opaque origin，crypto.subtle、localStorage、IndexedDB
 * 都不可用或不可靠；官方登录的回跳地址也必须是一个 loopback 源。改用本机 HTTP 服务托管
 * 构建产物后，页面拿到的是 http://127.0.0.1:&lt;port&gt; 这样的正常源，以上问题一并解决。
 *
 * 另外把 /__auth/ 反代到 Platform：网页到本地服务是同源请求，不需要 CORS，
 * 与开发服务器上的同名代理行为一致。
 */
final class LocalServer implements Closeable {

    /** 静态文件来源：Android 侧是 AssetManager，测试侧可以是文件系统 */
    interface Source {
        /** @return 文件流，不存在时抛 IOException */
        InputStream open(String path) throws IOException;
    }

    /** 与 rspack.config.ts 里的 authOrigin 一致 */
    private static final String AUTH_PREFIX = "/__auth/";
    private static final String AUTH_TARGET = "https://platform.deepseek.com/";
    /** 固定的端口候选：源（含端口）决定 WebView 存储归属，端口变了本地数据就找不回来了 */
    private static final int[] PREFERRED_PORTS = { 47113, 47114, 47115 };
    /** 请求体上限：本应用只往 /__auth 发小段 JSON，1 MiB 足够，防止被超大长度值耗尽内存 */
    private static final int MAX_BODY_BYTES = 1024 * 1024;
    /** 单行请求头上限与请求头数量上限，避免无界的头部把内存吃满 */
    private static final int MAX_LINE_BYTES = 8 * 1024;
    private static final int MAX_HEADERS = 100;
    /** 需要原样转发的请求头：Platform 用它识别客户端与调用方 */
    private static final String[] FORWARD_HEADERS = {
            "content-type", "accept", "x-client-platform", "x-client-bundle-id",
            "x-client-version", "x-client-locale", "x-client-timezone-offset",
            "x-dsh-auth-token",
    };

    private final Source source;
    private final ServerSocket socket;
    private final ExecutorService workers = Executors.newFixedThreadPool(8);
    private volatile boolean closed;

    LocalServer(Source source) throws IOException {
        this.source = source;
        this.socket = bind();
        Thread acceptor = new Thread(this::acceptLoop, "local-server");
        acceptor.setDaemon(true);
        acceptor.start();
    }

    private static ServerSocket bind() throws IOException {
        InetAddress loopback = InetAddress.getByName("127.0.0.1");
        for (int port : PREFERRED_PORTS) {
            try {
                return new ServerSocket(port, 32, loopback);
            } catch (IOException taken) {
                // 端口被占用：换下一个候选
            }
        }
        // 全部占用时退回随机端口，本次仍可用，只是本地数据换了一个源
        return new ServerSocket(0, 32, loopback);
    }

    String origin() {
        return "http://127.0.0.1:" + socket.getLocalPort();
    }

    /** 服务端口；WebView 用它判断请求是否来自本应用自己的页面 */
    int port() {
        return socket.getLocalPort();
    }

    private void acceptLoop() {
        while (!closed) {
            try {
                Socket client = socket.accept();
                workers.execute(() -> handle(client));
            } catch (IOException error) {
                if (!closed) {
                    // 单次 accept 失败不结束服务，继续等待下一个连接
                }
            }
        }
    }

    private void handle(Socket client) {
        try (Socket connection = client) {
            connection.setSoTimeout(30_000);
            OutputStream out = connection.getOutputStream();
            Request request;
            try {
                request = Request.read(connection.getInputStream());
            } catch (BodyTooLargeException tooLarge) {
                writeResponse(out, 413, "text/plain; charset=utf-8",
                        "Payload Too Large".getBytes(StandardCharsets.UTF_8));
                out.flush();
                return;
            }
            if (request == null) {
                writeResponse(out, 400, "text/plain; charset=utf-8",
                        "Bad Request".getBytes(StandardCharsets.UTF_8));
                out.flush();
                return;
            }
            if (request.path.startsWith(AUTH_PREFIX)) {
                proxy(request, out);
            } else {
                serveAsset(request, out);
            }
            out.flush();
        } catch (IOException ignored) {
            // 客户端提前断开、正文不完整或超时都按连接失败处理
        }
    }

    /** 托管 assets/www；找不到的路径一律回落到 index.html，等价于部署侧的 SPA fallback */
    private void serveAsset(Request request, OutputStream out) throws IOException {
        String path = sanitize(request.path);
        byte[] body = readAsset(path);
        if (body == null) {
            path = "/index.html";
            body = readAsset(path);
        }
        if (body == null) {
            writeResponse(out, 404, "text/plain; charset=utf-8", "Not Found".getBytes(StandardCharsets.UTF_8));
            return;
        }
        writeResponse(out, 200, contentType(path), body);
    }

    private byte[] readAsset(String path) {
        try (InputStream input = source.open(path)) {
            return readAll(input);
        } catch (IOException missing) {
            return null;
        }
    }

    /** 去掉查询串并挡住目录穿越 */
    private static String sanitize(String rawPath) {
        String path = rawPath;
        int query = path.indexOf('?');
        if (query >= 0) {
            path = path.substring(0, query);
        }
        if (path.isEmpty() || path.equals("/")) {
            return "/index.html";
        }
        if (path.contains("..")) {
            return "/index.html";
        }
        return path;
    }

    /** 把 /__auth/xxx 转发到 Platform，并把状态码与响应体原样带回页面 */
    private void proxy(Request request, OutputStream out) throws IOException {
        String suffix = request.path.substring(AUTH_PREFIX.length());
        HttpURLConnection connection = (HttpURLConnection) new URL(AUTH_TARGET + suffix).openConnection();
        connection.setRequestMethod(request.method);
        connection.setInstanceFollowRedirects(false);
        connection.setConnectTimeout(20_000);
        connection.setReadTimeout(30_000);
        for (String name : FORWARD_HEADERS) {
            String value = request.headers.get(name);
            if (value != null) {
                connection.setRequestProperty(name, value);
            }
        }
        if (request.body.length > 0) {
            connection.setDoOutput(true);
            connection.setFixedLengthStreamingMode(request.body.length);
            try (OutputStream body = connection.getOutputStream()) {
                body.write(request.body);
            }
        }
        int status = connection.getResponseCode();
        String contentType = connection.getContentType();
        InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
        byte[] payload = stream == null ? new byte[0] : readAll(stream);
        connection.disconnect();
        writeResponse(out, status, contentType == null ? "application/json; charset=utf-8" : contentType, payload);
    }

    private static void writeResponse(OutputStream out, int status, String contentType, byte[] body)
            throws IOException {
        String head = "HTTP/1.1 " + status + " " + reason(status) + "\r\n"
                + "Content-Type: " + contentType + "\r\n"
                + "Content-Length: " + body.length + "\r\n"
                + "Cache-Control: no-store\r\n"
                + "Connection: close\r\n\r\n";
        out.write(head.getBytes(StandardCharsets.ISO_8859_1));
        out.write(body);
    }

    private static String reason(int status) {
        switch (status) {
            case 200: return "OK";
            case 204: return "No Content";
            case 400: return "Bad Request";
            case 401: return "Unauthorized";
            case 404: return "Not Found";
            case 405: return "Method Not Allowed";
            default: return status < 400 ? "OK" : "Error";
        }
    }

    private static String contentType(String path) {
        String lower = path.toLowerCase(Locale.ROOT);
        if (lower.endsWith(".html")) return "text/html; charset=utf-8";
        if (lower.endsWith(".js")) return "text/javascript; charset=utf-8";
        if (lower.endsWith(".css")) return "text/css; charset=utf-8";
        if (lower.endsWith(".json")) return "application/json; charset=utf-8";
        if (lower.endsWith(".svg")) return "image/svg+xml";
        if (lower.endsWith(".png")) return "image/png";
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
        if (lower.endsWith(".webp")) return "image/webp";
        if (lower.endsWith(".ico")) return "image/x-icon";
        if (lower.endsWith(".woff2")) return "font/woff2";
        if (lower.endsWith(".woff")) return "font/woff";
        if (lower.endsWith(".ttf")) return "font/ttf";
        return "application/octet-stream";
    }

    private static byte[] readAll(InputStream input) throws IOException {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        byte[] chunk = new byte[16 * 1024];
        int read;
        while ((read = input.read(chunk)) != -1) {
            buffer.write(chunk, 0, read);
        }
        return buffer.toByteArray();
    }

    @Override
    public void close() {
        closed = true;
        try {
            socket.close();
        } catch (IOException ignored) {
            // 关闭失败不影响进程退出
        }
        workers.shutdownNow();
    }

    /** 声明长度超过上限的请求，按 413 回绝，绝不先分配数组 */
    private static final class BodyTooLargeException extends IOException {
        BodyTooLargeException(int declared) {
            super("declared body too large: " + declared);
        }
    }

    /** 一次请求：只解析请求行、请求头和由 Content-Length 标注的正文 */
    private static final class Request {
        final String method;
        final String path;
        final Map<String, String> headers;
        final byte[] body;

        private Request(String method, String path, Map<String, String> headers, byte[] body) {
            this.method = method;
            this.path = path;
            this.headers = headers;
            this.body = body;
        }

        static Request read(InputStream input) throws IOException {
            String requestLine = readLine(input);
            if (requestLine == null || requestLine.isEmpty()) {
                return null;
            }
            String[] parts = requestLine.split(" ");
            if (parts.length < 2) {
                return null;
            }
            Map<String, String> headers = new HashMap<>();
            for (String line = readLine(input); line != null && !line.isEmpty(); line = readLine(input)) {
                if (headers.size() >= MAX_HEADERS) {
                    return null;
                }
                int colon = line.indexOf(':');
                if (colon > 0) {
                    headers.put(line.substring(0, colon).trim().toLowerCase(Locale.ROOT),
                            line.substring(colon + 1).trim());
                }
            }
            // 声明长度必须可解析且不超过上限；否则直接拒绝，避免按攻击者给的长度分配内存
            int length = 0;
            String declared = headers.get("content-length");
            if (declared != null) {
                try {
                    length = Integer.parseInt(declared);
                } catch (NumberFormatException invalid) {
                    return null;
                }
                if (length < 0) {
                    return null;
                }
                if (length > MAX_BODY_BYTES) {
                    throw new BodyTooLargeException(length);
                }
            }
            byte[] body = new byte[length];
            int offset = 0;
            while (offset < body.length) {
                int read = input.read(body, offset, body.length - offset);
                if (read < 0) {
                    // 正文比声明短：不能把半截数据当成完整请求
                    throw new IOException("incomplete body");
                }
                offset += read;
            }
            return new Request(parts[0], parts[1], headers, body);
        }

        /** 按 ISO-8859-1 逐字节读到换行，兼容 CRLF 与只有 LF 的客户端 */
        private static String readLine(InputStream input) throws IOException {
            ByteArrayOutputStream line = new ByteArrayOutputStream();
            int value = -1;
            while ((value = input.read()) != -1) {
                if (value == '\n') {
                    break;
                }
                if (value != '\r') {
                    line.write(value);
                    if (line.size() > MAX_LINE_BYTES) {
                        // 超长的请求行或请求头：按格式错误处理，不继续读取
                        return null;
                    }
                }
            }
            if (value == -1 && line.size() == 0) {
                return null;
            }
            return line.toString("ISO-8859-1");
        }
    }
}
