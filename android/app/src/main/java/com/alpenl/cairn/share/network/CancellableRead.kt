package com.alpenl.cairn.share.network

import java.net.HttpURLConnection
import java.util.concurrent.Executors
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.suspendCancellableCoroutine

/** Only GETs use this cancellation seam: an interrupted write may have committed. */
internal class ReadCancellation {
    private var cancelled = false
    private var connection: HttpURLConnection? = null

    @Synchronized fun attach(value: HttpURLConnection) {
        if (cancelled) { value.disconnect(); throw java.io.InterruptedIOException("Read cancelled") }
        connection = value
    }
    @Synchronized fun release(value: HttpURLConnection) { if (connection === value) connection = null }
    @Synchronized fun cancel() { cancelled = true; connection?.disconnect(); connection = null }
}

private val readExecutor = Executors.newFixedThreadPool(4) { runnable ->
    Thread(runnable, "cairn-read").apply { isDaemon = true }
}

internal suspend fun <T> cancellableRead(read: (ReadCancellation) -> T): T = suspendCancellableCoroutine { continuation ->
    val cancellation = ReadCancellation()
    val task = readExecutor.submit {
        try {
            val value = read(cancellation)
            if (continuation.isActive) continuation.resume(value)
        } catch (error: Exception) {
            if (continuation.isActive) continuation.resumeWithException(error)
        }
    }
    continuation.invokeOnCancellation { cancellation.cancel(); task.cancel(true) }
}
