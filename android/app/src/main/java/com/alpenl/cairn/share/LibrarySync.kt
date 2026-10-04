package com.alpenl.cairn.share

import android.app.Application
import android.content.Context
import android.net.ConnectivityManager
import androidx.work.*
import com.alpenl.cairn.share.network.*
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

class CairnApplication : Application(), Configuration.Provider {
    override val workManagerConfiguration: Configuration get() = Configuration.Builder().build()
}

internal object LibrarySync {
    private val locks = mutableMapOf<String, Mutex>()
    val updates = MutableSharedFlow<String>(extraBufferCapacity = 8)
    suspend fun <T> exclusive(account: String, block: suspend () -> T): T =
        synchronized(locks) { locks.getOrPut(account) { Mutex() } }.withLock { block() }

    /** The cursor commits with the content and durable media queue, never with a download. */
    suspend fun run(context: Context, base: String, token: String, background: Boolean = false,
        progress: (String) -> Unit = {}): Boolean {
        val account = accountKeyFor(base, token)
        return exclusive(account) {
            val settings = SharePreferencesStore(context)
            val store = OfflineReadStore(context)
            val mediaStore = LocalMediaStore(context)
            suspend fun active() {
                val current = settings.preferences.first()
                if (current.apiToken.trim() != token.trim() || (background && !current.automaticSync)) throw CancellationException()
            }
            var resets = 0
            var pages = 0
            while (true) {
                active()
                if (++pages > 2000) throw IOException("本次更新已保存进度，将在下次继续。")
                val expected = store.syncState(account)
                when (val response = LibrarySyncClient(base).page(token, expected.cursor)) {
                    LibrarySyncResult.Unsupported -> return@exclusive false
                    LibrarySyncResult.Unauthorized -> throw IOException("访问凭证已失效，请重新配置连接。")
                    LibrarySyncResult.Failed -> throw IOException("暂时无法连接，已保存进度，联网后继续。")
                    LibrarySyncResult.Reset -> {
                        if (++resets > 1) throw IOException("服务正在更新，请稍后重试。")
                        store.resetSync(account)
                    }
                    is LibrarySyncResult.Page -> {
                        active()
                        val page = response.value
                        if (page.more && page.cursor == expected.cursor) throw IOException("更新进度异常，请稍后重试。")
                        if (!store.applySyncPage(account, expected, page)) continue
                        for (id in page.deleted) { BookmarkImageCache.forget(account, id); mediaStore.remove(account, id) }
                        updates.tryEmit(account)
                        progress("已更新 ${store.storageInfo(account).records} 条收藏…")
                        if (!page.more) break
                    }
                }
            }
            active()
            val links = store.catalog(account)
            mediaStore.prune(account, links.associate { link -> link.id to link.enrichment?.imageVersions.orEmpty().toList().toSet() })
            val pending = store.pendingMedia(account)
            val api = LinksApiClient(base)
            for ((index, media) in pending.withIndex()) {
                active()
                val preferences = settings.preferences.first()
                val metered = (context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager).isActiveNetworkMetered
                if (preferences.imagesWifiOnly && metered) break
                if (!media.available) continue
                // An If-Match response prevents new bytes from being filed under an old version.
                val bytes = mediaStore.load(account, media.key, media.version) { api.image(media.key, token, media.version) }
                active()
                if (bytes != null) store.mediaSaved(account, media)
                progress("资料已更新 · 正在保存图片 ${index + 1} / ${pending.size}")
            }
            store.syncError(account, "")
            val info = store.storageInfo(account)
            progress("${info.records} 条收藏已更新 · ${info.savedImages} 张图片已保存" +
                if (info.pendingImages > 0) " · ${info.pendingImages} 张等待下载" else " · 可离线阅读")
            updates.tryEmit(account)
            true
        }
    }

    fun schedule(context: Context, base: String, token: String, enabled: Boolean, immediate: Boolean = true) {
        val manager = WorkManager.getInstance(context)
        val name = "library:${accountKeyFor(base, token)}"
        if (!enabled || token.isBlank()) { manager.cancelUniqueWork(name); manager.cancelUniqueWork("$name:now"); manager.cancelUniqueWork("$name:images"); return }
        val data = workDataOf("base" to base, "account" to accountKeyFor(base, token))
        val connected = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
        manager.enqueueUniquePeriodicWork(name, ExistingPeriodicWorkPolicy.KEEP,
            PeriodicWorkRequestBuilder<LibrarySyncWorker>(15, TimeUnit.MINUTES).setInputData(data).setConstraints(connected)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build())
        if (immediate) manager.enqueueUniqueWork("$name:now", ExistingWorkPolicy.KEEP,
            OneTimeWorkRequestBuilder<LibrarySyncWorker>().setInputData(data).setConstraints(connected).build())
        // Kept across process death; a metered metadata pass must not consume the Wi-Fi job.
        manager.enqueueUniqueWork("$name:images", ExistingWorkPolicy.KEEP,
            OneTimeWorkRequestBuilder<LibrarySyncWorker>().setInputData(data)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.UNMETERED).build()).build())
    }
}

class LibrarySyncWorker(context: Context, parameters: WorkerParameters) : CoroutineWorker(context, parameters) {
    override suspend fun doWork(): Result {
        val base = inputData.getString("base") ?: return Result.failure()
        val prefs = SharePreferencesStore(applicationContext).preferences.first()
        if (!prefs.automaticSync || prefs.apiToken.isBlank() || accountKeyFor(base, prefs.apiToken) != inputData.getString("account")) return Result.success()
        return try {
            if (!LibrarySync.run(applicationContext, base, prefs.apiToken, background = true)) Result.success()
            else if (OfflineReadStore(applicationContext).pendingMedia(accountKeyFor(base, prefs.apiToken)).any { it.available } &&
                !(prefs.imagesWifiOnly && (applicationContext.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager).isActiveNetworkMetered)) Result.retry()
            else Result.success()
        } catch (error: CancellationException) { throw error }
        catch (error: IOException) {
            val account = accountKeyFor(base, prefs.apiToken)
            OfflineReadStore(applicationContext).syncError(account, error.message ?: "更新暂未完成")
            LibrarySync.updates.tryEmit(account)
            Result.retry()
        }
    }
}
