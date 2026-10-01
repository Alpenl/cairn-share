package com.alpenl.cairn.share.network

import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.*
import org.junit.Assert.*
import org.junit.Test

class ReadCancellationTest {
    private class Connection : HttpURLConnection(URL("https://unused.invalid")) {
        var disconnected = false
        override fun disconnect() { disconnected = true }
        override fun usingProxy() = false
        override fun connect() = Unit
    }
    @Test fun `cancellation disconnects the active GET and cannot attach a late connection`() {
        val request = ReadCancellation()
        val connection = Connection(); request.attach(connection); request.cancel()
        assertTrue(connection.disconnected)
        val late = Connection()
        assertTrue(runCatching { request.attach(late) }.isFailure)
        assertTrue(late.disconnected)
    }
    @Test fun `released connection does not affect a later cancellation`() {
        val request = ReadCancellation(); val connection = Connection()
        request.attach(connection); request.release(connection); request.cancel()
        assertFalse(connection.disconnected)
    }
    @Test fun `cancelled coroutine releases a blocking read promptly`() = runBlocking {
        val entered = CountDownLatch(1)
        val connection = Connection()
        val job = launch { cancellableRead { request -> request.attach(connection); entered.countDown(); CountDownLatch(1).await(30, TimeUnit.SECONDS) } }
        withContext(Dispatchers.IO) { assertTrue(entered.await(3, TimeUnit.SECONDS)) }
        withTimeout(1_000) { job.cancelAndJoin() }
        assertTrue(connection.disconnected)
    }
}
