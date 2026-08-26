package com.alpenl.cairn.share.network

import java.io.InputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Test

class ShareApiClientTest {
    @Test
    fun saveSendsStableUserAgent() {
        val userAgents = LinkedBlockingQueue<String>()
        val server = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))
        val serverThread = Thread {
            server.use { socketServer ->
                socketServer.accept().use { socket ->
                    val input = socket.getInputStream()
                    val headers = readHeaders(input)
                    headers.firstOrNull { it.startsWith("User-Agent:", ignoreCase = true) }
                        ?.substringAfter(':')
                        ?.trim()
                        ?.let(userAgents::offer)
                    val contentLength = headers.firstOrNull { it.startsWith("Content-Length:", ignoreCase = true) }
                        ?.substringAfter(':')
                        ?.trim()
                        ?.toIntOrNull()
                        ?: 0
                    input.readNBytes(contentLength)
                    socket.getOutputStream().write(
                        "HTTP/1.1 201 Created\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}"
                            .toByteArray(Charsets.US_ASCII),
                    )
                }
            }
        }
        serverThread.start()

        try {
            val result = ShareApiClient(
                baseUrl = "http://127.0.0.1:${server.localPort}",
                userAgent = "CairnShareAndroid/test (Android)",
            ).save("https://example.com/article", "稍后阅读")

            assertEquals(ShareSubmitResult.Saved, result)
            assertEquals("CairnShareAndroid/test (Android)", userAgents.poll(5, TimeUnit.SECONDS))
        } finally {
            server.close()
            serverThread.join(5_000)
        }
    }

    private fun readHeaders(input: InputStream): List<String> {
        val bytes = mutableListOf<Byte>()
        while (!bytes.endsWithCrlfCrlf()) {
            val next = input.read()
            if (next == -1) break
            bytes += next.toByte()
        }
        return bytes.toByteArray()
            .toString(Charsets.ISO_8859_1)
            .split("\r\n")
            .filter(String::isNotEmpty)
    }

    private fun List<Byte>.endsWithCrlfCrlf(): Boolean {
        if (size < 4) return false
        return this[size - 4] == '\r'.code.toByte() &&
            this[size - 3] == '\n'.code.toByte() &&
            this[size - 2] == '\r'.code.toByte() &&
            this[size - 1] == '\n'.code.toByte()
    }
}
