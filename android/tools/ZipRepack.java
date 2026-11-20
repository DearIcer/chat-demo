import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Enumeration;
import java.util.stream.Stream;
import java.util.zip.CRC32;
import java.util.zip.Deflater;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
import java.util.zip.ZipOutputStream;

/**
 * 把 aapt2 链接出的资源、d8 生成的 classes.dex 和 assets 组装成 APK。
 *
 * 不用 .NET 的 ZipArchive：Windows PowerShell 5.1 跑在 .NET Framework 上，
 * ZipArchive 会忽略 CompressionLevel.NoCompression，把 resources.arsc 压成 deflate，
 * 而 targetSdk 30+ 要求它必须未压缩存储。
 *
 * 用法：java ZipRepack <base.apk> <out.apk> <classes.dex> <assetsDir>
 */
public final class ZipRepack {

    public static void main(String[] args) throws IOException {
        if (args.length < 4) {
            System.err.println("usage: ZipRepack <base.apk> <out.apk> <classes.dex> <assetsDir>");
            System.exit(2);
        }
        Path base = Paths.get(args[0]);
        Path out = Paths.get(args[1]);
        Path dex = Paths.get(args[2]);
        Path assets = Paths.get(args[3]);
        if (!Files.isRegularFile(dex)) {
            throw new IOException("missing classes.dex: " + dex);
        }
        if (!Files.isDirectory(assets)) {
            throw new IOException("missing assets dir: " + assets);
        }

        try (ZipFile source = new ZipFile(base.toFile());
             ZipOutputStream target = new ZipOutputStream(
                     new BufferedOutputStream(new FileOutputStream(out.toFile())))) {
            target.setLevel(Deflater.BEST_COMPRESSION);

            Enumeration<? extends ZipEntry> entries = source.entries();
            while (entries.hasMoreElements()) {
                ZipEntry entry = entries.nextElement();
                if (entry.isDirectory()) {
                    continue;
                }
                byte[] data = readAll(source.getInputStream(entry));
                boolean store = entry.getMethod() == ZipEntry.STORED
                        || "resources.arsc".equals(entry.getName());
                writeEntry(target, entry.getName(), data, store);
            }

            writeEntry(target, "classes.dex", Files.readAllBytes(dex), false);

            Path root = assets.toAbsolutePath().normalize();
            try (Stream<Path> walk = Files.walk(root)) {
                for (Path file : (Iterable<Path>) walk.filter(Files::isRegularFile)::iterator) {
                    String relative = root.relativize(file).toString().replace(File.separatorChar, '/');
                    writeEntry(target, "assets/www/" + relative, Files.readAllBytes(file), false);
                }
            }
        }
    }

    private static void writeEntry(ZipOutputStream target, String name, byte[] data, boolean store)
            throws IOException {
        ZipEntry entry = new ZipEntry(name);
        if (store) {
            CRC32 crc = new CRC32();
            crc.update(data);
            entry.setMethod(ZipEntry.STORED);
            entry.setSize(data.length);
            entry.setCompressedSize(data.length);
            entry.setCrc(crc.getValue());
        } else {
            entry.setMethod(ZipEntry.DEFLATED);
        }
        target.putNextEntry(entry);
        target.write(data);
        target.closeEntry();
    }

    private static byte[] readAll(InputStream input) throws IOException {
        try (InputStream stream = input) {
            return stream.readAllBytes();
        }
    }
}
