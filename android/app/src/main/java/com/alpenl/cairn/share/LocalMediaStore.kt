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
import kotlinx.coroutines.withContext

/** Files survive process death and are never part of the system's disposable cache. */
internal class LocalMediaStore(context: Context) {
    private val root = File(context.applicationContext.filesDir, "library-images")

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
        val bytes = fetch() ?: return@withContext null
        ensureActive()
        if (!validImage(bytes)) return@withContext null
        synchronized(LOCK) {
            if (epoch != (epochs[account] ?: 0L) || File(directory, ".deleted").exists() || BookmarkImageCache.isDeleted(account, key)) return@withContext null
            val output = file.startWrite()
            try { output.write(bytes); file.finishWrite(output) }
            catch (error: IOException) { file.failWrite(output); throw error }
        }
        bytes
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
