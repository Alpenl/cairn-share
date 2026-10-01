package com.alpenl.cairn.share.network

import java.net.InetAddress
import java.net.ServerSocket
import java.util.Collections
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class CurationEndpointContractTest {
    private fun withServer(body: String, status: Int = 200, test: (V2CurationClient, MutableList<Pair<String, JSONObject>>) -> Unit) {
        val requests = Collections.synchronizedList(mutableListOf<Pair<String, JSONObject>>())
        val server = ServerSocket(0, 4, InetAddress.getByName("127.0.0.1"))
        val responder = Thread {
            try {
                while (!server.isClosed) server.accept().use { socket ->
                    val reader = socket.getInputStream().bufferedReader()
                    val request = reader.readLine()
                    var length = 0
                    while (true) {
                        val header = reader.readLine() ?: break
                        if (header.isEmpty()) break
                        if (header.substringBefore(':').equals("Content-Length", true)) length = header.substringAfter(':').trim().toInt()
                    }
                    val chars = CharArray(length)
                    var read = 0
                    while (read < length) read += reader.read(chars, read, length - read)
                    requests.add(request to if (length == 0) JSONObject() else JSONObject(String(chars)))
                    val bytes = body.toByteArray()
                    socket.getOutputStream().write(("HTTP/1.1 $status Fixture\r\nContent-Type: application/json\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n").toByteArray() + bytes)
                }
            } catch (_: java.io.IOException) { /* Closing the fixture ends accept(). */ }
        }.apply { isDaemon = true; start() }
        try { test(V2CurationClient("http://127.0.0.1:${server.localPort}", userAgent = "unit-test"), requests) }
        finally { server.close(); responder.join(1_000) }
    }

    @Test fun `persisted legacy intent keeps original endpoint key and CAS after rebase`() {
        val legacy = QueuedCurationAction.decode(JSONObject("""{"link_id":7,"operation_key":"before-upgrade","field":"topics","term":"llm","action":"accept","expected_revision":3,"account_key":"account","queue_version":1}"""))
        assertTrue(legacy.legacyEndpoint)
        val rebased = legacy.copy(expectedRevision = 9, expectedDecisionId = 17, expectedContentRevision = 4)
        assertTrue(QueuedCurationAction.decode(rebased.encode()).legacyEndpoint)
        withServer("""{"id":7,"revision":4,"replayed":true}""") { client, requests ->
            assertTrue(client.applyOverride(7, FieldOverride("topics", "llm", "accept", legacy.operationKey, 3,
                legacyEndpoint = legacy.legacyEndpoint), "unit-token") is V2Result.Loaded)
            assertEquals(1, requests.size)
            assertEquals("POST /api/bookmarks/7/v2-override HTTP/1.1", requests.single().first)
            assertEquals("before-upgrade", requests.single().second.getString("operation_key"))
            assertEquals(3L, requests.single().second.getLong("expected_revision"))
        }
    }

    @Test fun `modern intent preserves protocol marker and original binding`() {
        val row = QueuedCurationAction(7, "modern", "topics", "ai_coding", "accept", 3, "account",
            expectedDecisionId = 17, expectedContentRevision = 4, legacyEndpoint = false)
        assertFalse(QueuedCurationAction.decode(row.encode()).legacyEndpoint)
        assertFalse(QueuedCurationAction.decode(row.encode().apply { remove("legacy_endpoint") }).legacyEndpoint)
        withServer("""{"id":7,"operation_id":"modern","operation_revision":4,"replayed":true}""") { client, requests ->
            val result = client.applyOverride(7, FieldOverride(row.field, row.term, row.action, row.operationKey,
                row.expectedRevision, row.expectedDecisionId, row.expectedContentRevision), "unit-token") as V2Result.Loaded
            assertEquals(4L, result.value.getLong("revision"))
            assertEquals("POST /api/bookmarks/7/tags HTTP/1.1", requests.single().first)
            assertEquals(17L, requests.single().second.getLong("expected_decision_id"))
            assertEquals(4L, requests.single().second.getLong("expected_content_revision"))
        }
    }

    @Test fun `missing modern evidence binding cannot silently write through legacy endpoint`() {
        withServer("""{"id":7,"revision":3,"decision_id":17,"content_revision":4}""") { client, requests ->
            assertEquals(V2Result.Failed(FailureKind.Server), client.applyOverride(7,
                FieldOverride("topics", "ai_coding", "accept", "modern", 3), "unit-token"))
            assertTrue(requests.isEmpty())
        }
        val missing = JSONObject("""{"revision":3,"selection":{"topics":[],"content_functions":[],"carriers":[],"affordances":[],"form":"","use":""}}""")
        assertEquals(V2Result.Failed(FailureKind.Server), V2CurationClient("http://unused").decodeSelection(missing, tagSystem = true))
        assertTrue(V2CurationClient("http://unused").decodeSelection(missing) is V2Result.Loaded)
    }

    @Test fun `unsupported modern endpoint never resends operation through legacy endpoint`() {
        for (status in listOf(404, 405)) withServer("{}", status) { client, requests ->
            assertEquals(V2Result.Unsupported, client.applyOverride(7,
                FieldOverride("topics", "ai_coding", "accept", "modern", 3, 17, 4), "unit-token"))
            assertEquals(listOf("POST /api/bookmarks/7/tags HTTP/1.1"), requests.map { it.first })
        }
    }
}
