package com.alpenl.cairn.share.network

import java.net.ServerSocket
import java.util.concurrent.atomic.AtomicReference
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class QueueApiContractTest {
    @Test fun `oldest unread queue uses capability keyset cursor and global total`() {
        val seen = AtomicReference<String>()
        val body = AtomicReference("""{"links":[{"id":2,"url":"https://example.com/old","created_at":"2020-01-01T00:00:00Z","learned":false}],"next_cursor":"opaque-next","total":6001}""")
        val capability = AtomicReference("1")
        val headers = AtomicReference<Map<String, String>>()
        val server = ServerSocket(0, 4, java.net.InetAddress.getByName("127.0.0.1"))
        val responder = Thread {
            try {
                while (!server.isClosed) server.accept().use { socket ->
                    val reader = socket.getInputStream().bufferedReader()
                    val line = reader.readLine()
                    seen.set(line.substringAfter('?').substringBefore(' '))
                    val fields = mutableMapOf<String, String>()
                    while (true) {
                        val header = reader.readLine() ?: break
                        if (header.isEmpty()) break
                        fields[header.substringBefore(':').lowercase()] = header.substringAfter(':').trim()
                    }
                    headers.set(fields)
                    val bytes = body.get().toByteArray()
                    val flag = capability.get().takeIf { it.isNotBlank() }?.let { "X-Cairn-Queue: $it\r\n" }.orEmpty()
                    socket.getOutputStream().write(("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n$flag\r\n").toByteArray() + bytes)
                }
            } catch (_: java.io.IOException) { /* Closing the local fixture ends accept(). */ }
        }.apply { isDaemon = true; start() }
        try {
            val client = LinksApiClient("http://127.0.0.1:${server.localPort}", userAgent = "unit-test")
            val loaded = client.queuePage("unit-token", "opaque/previous") as QueuePageResult.Loaded
            assertEquals("1", headers.get()["x-cairn-queue"])
            assertEquals("1", headers.get()["x-cairn-tag-system"])
            assertEquals("1", headers.get()["x-cairn-content-functions"])
            assertEquals(6001, loaded.page.total)
            assertEquals(2, loaded.page.items.single().id)
            assertEquals("opaque-next", loaded.page.nextCursor)
            assertTrue(seen.get().contains("cursor=opaque%2Fprevious"))
            capability.set("")
            assertEquals(QueuePageResult.Unsupported, client.queuePage("unit-token"))
            capability.set("1")
            body.set(JSONObject(body.get()).put("next_cursor", "same").toString())
            assertEquals(QueuePageResult.Failed(FailureKind.Server), client.queuePage("unit-token", "same"))
            body.set(JSONObject(body.get()).apply { getJSONArray("links").getJSONObject(0).put("learned", true) }.toString())
            assertEquals(QueuePageResult.Failed(FailureKind.Server), client.queuePage("unit-token"))
        } finally { server.close(); responder.join(1_000) }
    }
    @Test fun `function any and all combine with other groups without losing intent`() {
        val link = LinkJson.decodeLink(JSONObject("""{"id":1,"url":"https://example.com","created_at":"now","learned":false,"enrichment":{"classification":{"topics":["llm"],"content_functions":["method"]}}}"""))
        val any = BookmarkFilters(topics = listOf("llm"), contentFunctions = listOf("method", "tool"))
        assertTrue(any.matches(link))
        assertFalse(any.copy(functionsMode = "all").matches(link))
        assertEquals("all", any.copy(functionsMode = "all").parameters()["functions_mode"])
    }
}
