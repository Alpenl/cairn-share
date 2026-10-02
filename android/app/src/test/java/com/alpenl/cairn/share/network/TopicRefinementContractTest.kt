package com.alpenl.cairn.share.network

import java.net.ServerSocket
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.*
import org.junit.Test

class TopicRefinementContractTest {
    @Test fun `refined list and counts require acknowledgement while old ordinary lists remain usable`() {
        val seen = AtomicReference("")
        val headers = AtomicReference<Map<String, String>>(emptyMap())
        val acknowledge = AtomicReference(true)
        val server = ServerSocket(0, 4, java.net.InetAddress.getByName("127.0.0.1"))
        val responder = Thread {
            try { while (!server.isClosed) server.accept().use { socket ->
                val reader = socket.getInputStream().bufferedReader()
                seen.set(reader.readLine())
                val fields = mutableMapOf<String, String>()
                while (true) { val line = reader.readLine() ?: break; if (line.isEmpty()) break
                    fields[line.substringBefore(':').lowercase()] = line.substringAfter(':').trim() }
                headers.set(fields)
                val body = """{"items":[],"next_before_id":null,"filter_contract_version":1,"total":0,"topics":[]}""".toByteArray()
                val cap = if (acknowledge.get()) "X-Cairn-Topic-Granularity: 1\r\n" else ""
                socket.getOutputStream().write(("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${body.size}\r\nConnection: close\r\nX-Cairn-Tag-System: 1\r\n$cap\r\n").toByteArray() + body)
            } } catch (_: java.io.IOException) { /* fixture closed */ }
        }.apply { isDaemon = true; start() }
        try {
            val url = "http://127.0.0.1:${server.localPort}"
            val client = LinksApiClient(url, userAgent = "test")
            val filters = BookmarkFilters(topics = listOf("image_creation", "design"), topicRefinements = listOf("portrait"))
            assertTrue(client.listPage(LinkFilter.All, "", "test", filters = filters) is LinkPageResult.Loaded)
            assertTrue(seen.get().contains("topic_refinements=portrait"))
            assertEquals("1", headers.get()["x-cairn-topic-granularity"])
            acknowledge.set(false)
            assertEquals(LinkPageResult.UnsupportedFilters, client.listPage(LinkFilter.All, "", "test", filters = filters))
            assertTrue(client.listPage(LinkFilter.All, "", "test") is LinkPageResult.Loaded)
            assertEquals(V2Result.Unsupported, V2CurationClient(url).tagRequest("/api/tag-counts?topic_refinements=portrait", "GET", "test"))
            acknowledge.set(true)
            assertTrue(V2CurationClient(url).tagRequest("/api/tag-counts?topic_refinements=portrait", "GET", "test") is V2Result.Loaded)
        } finally { server.close(); responder.join(1_000) }
    }
}
