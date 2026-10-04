package com.alpenl.cairn.share

import android.content.Context
import android.graphics.BitmapFactory
import android.util.AtomicFile
import com.alpenl.cairn.share.network.SavedLink
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withContext

/** Files survive process death and are never part of the system's disposable cache. */
internal class LocalMediaStore(context: Context) {
    private val app = context.applicationContext
    private val root = File(app.filesDir, "library-images")

    suspend fun load(account: String, key: String, version: String, fetch: () -> ByteArray?): ByteArray? = withContext(Dispatchers.IO) {
        if (!VALID_KEY.matches(key) || version.isBlank()) return@withContext fetch()
        val directory = File(root, "${digest(account)}/${key.split('/')[1]}")
        val file = AtomicFile(File(directory, digest("$key|$version")))
        val epoch: Long
        synchronized(LOCK) {
            epoch = epochs[account] ?: 0L
            if (File(directory, ".deleted").exists() || BookmarkImageCache.isDeleted(account, key)) return@withContext null
            if (file.baseFile.exists()) {
                val cached = file.openRead().use { it.readBytes() }
                if (validImage(cached)) return@withContext cached
                file.delete()
            }
        }
        val preferences = SharePreferencesStore(app).preferences.first()
        val network = app.getSystemService(Context.CONNECTIVITY_SERVICE) as android.net.ConnectivityManager
        if (preferences.imagesWifiOnly && network.isActiveNetworkMetered) return@withContext null
        val bytes = fetch() ?: return@withContext null
        val limit = preferences.storageLimitMb * 1024 * 1024
        val textBytes = OfflineReadStore(app).storageInfo(account).textBytes
        ensureActive()
        if (!validImage(bytes)) return@withContext null
        synchronized(LOCK) {
            if (epoch != (epochs[account] ?: 0L) || File(directory, ".deleted").exists() || BookmarkImageCache.isDeleted(account, key)) return@withContext null
            if (android.os.StatFs(app.filesDir.path).availableBytes < bytes.size + 16L * 1024 * 1024 || diskBytes(account) + textBytes + bytes.size > limit)
                throw IOException("本地空间不足或已达到存储上限，可在设置中调整。")
            val output = file.startWrite()
            try { output.write(bytes); file.finishWrite(output) }
            catch (error: IOException) { file.failWrite(output); throw error }
        }
        bytes
    }

    fun diskBytes(account: String): Long = synchronized(LOCK) { File(root, digest(account)).walkTopDown().filter { it.isFile }.sumOf { it.length() } }
    suspend fun prune(account: String, keep: Map<Int, Set<Pair<String, String>>>) = withContext(Dispatchers.IO) {
        synchronized(LOCK) {
            val directory = File(root, digest(account))
            for (link in directory.listFiles().orEmpty()) {
                val wanted = keep[link.name.toIntOrNull()]
                if (wanted == null) { link.deleteRecursively(); continue }
                val names = wanted.map { digest("${it.first}|${it.second}") }.toSet()
                for (file in link.listFiles().orEmpty()) if (file.name != ".deleted" && file.name !in names) file.delete()
            }
        }
    }

    suspend fun remove(account: String, id: Int) = withContext(Dispatchers.IO) {
        synchronized(LOCK) {
            val directory = File(root, "${digest(account)}/$id")
            if (directory.exists() && !directory.deleteRecursively()) throw IOException("图片清理失败")
            if (!directory.mkdirs() && !directory.isDirectory) throw IOException("图片目录不可用")
            File(directory, ".deleted").writeText("")
        }
    }

    suspend fun clear(account: String) = withContext(Dispatchers.IO) {
        synchronized(LOCK) {
            epochs[account] = (epochs[account] ?: 0L) + 1
            val directory = File(root, digest(account))
            if (directory.exists() && !directory.deleteRecursively()) throw IOException("图片清理失败")
        }
    }

    private companion object {
        val LOCK = Any()
        val epochs = mutableMapOf<String, Long>()
        val VALID_KEY = Regex("enrichment/[1-9][0-9]*/[0-9a-f]{64}\\.(jpg|png|webp|gif|avif)")
        fun digest(value: String) = MessageDigest.getInstance("SHA-256").digest(value.toByteArray()).joinToString("") { "%02x".format(it.toInt() and 255) }
        fun validImage(bytes: ByteArray): Boolean {
            if (bytes.isEmpty() || bytes.size > 15 * 1024 * 1024) return false
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
            return bounds.outWidth > 0 && bounds.outHeight > 0
        }
    }
}

internal fun SavedLink.mediaVersion(): String = enrichment?.cacheIdentity?.let {
    "${it.schemaVersion}:${it.contentRevision}:${it.bodyRevision}"
}.orEmpty()
