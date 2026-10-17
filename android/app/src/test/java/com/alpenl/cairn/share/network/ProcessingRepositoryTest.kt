package com.alpenl.cairn.share.network

import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

class ProcessingRepositoryTest {
    private val account = "v2:" + "a".repeat(64)
    private val intent = ProcessingIntent("stable-operation", ProcessingIdentity("b".repeat(64), 3, 0), ProcessingAction.RetryClassification)
    private class Journal : ProcessingJournal {
        var value: StoredProcessingIntent? = null
        var broken = false
        override suspend fun load(accountKey: String, linkId: Int) = value?.takeIf { it.accountKey == accountKey && it.linkId == linkId }
        override suspend fun prepare(value: StoredProcessingIntent, expected: StoredProcessingIntent?) {
            check(!broken && this.value == expected)
            check(expected == null || expected.rejected != null || expected.intent == value.intent)
            this.value = value
        }
        override suspend fun reject(value: StoredProcessingIntent, code: String) { check(this.value == value); this.value = value.copy(rejected = code) }
        override suspend fun acknowledge(value: StoredProcessingIntent) { check(this.value == value); this.value = null }
        override suspend fun discardRefused(value: StoredProcessingIntent) { check(value.rejected != null && this.value == value); this.value = null }
    }
    private class Transport(val journal: Journal) : ProcessingTransport {
        val writes = mutableListOf<ProcessingIntent>()
        var reads = 0
        var result: ProcessingWriteResult = ProcessingWriteResult.Unknown(FailureKind.Network)
        override suspend fun status(id: Int, token: String): RunHistoryResult<ProcessingStatus> { reads++; return RunHistoryResult.Unsupported }
        override suspend fun submit(id: Int, token: String, intent: ProcessingIntent): ProcessingWriteResult {
            check(journal.value?.intent == intent)
            writes += intent
            return result
        }
    }
    @Test fun persistBeforeSendAndReadAfterRestartNeverAutomaticallyResendsUnknownPaidIntent() = runBlocking {
        val journal = Journal(); val transport = Transport(journal)
        val value = StoredProcessingIntent(account, 4, intent)
        var repository = ProcessingRepository(transport, journal)
        assertTrue(repository.submit(value, null, "not-persisted") { true } is ProcessingWriteResult.Unknown)
        assertEquals(value, journal.value); assertEquals(listOf(intent), transport.writes)
        repository = ProcessingRepository(transport, journal)
        assertEquals(value, repository.read(account, 4, "not-persisted").pending)
        assertEquals(1, transport.reads); assertEquals(1, transport.writes.size)
        assertNull(repository.read("v2:" + "c".repeat(64), 4, "foreign-token").pending)
        assertEquals(1, transport.writes.size)
        transport.result = ProcessingWriteResult.Confirmed(3, false, true, true)
        assertTrue(repository.submit(value, value, "not-persisted") { true } is ProcessingWriteResult.Confirmed)
        assertEquals(listOf(intent, intent), transport.writes); assertNull(journal.value)
    }
    @Test fun changedAccountOrFailedPersistenceCannotStartARequestAndUnknownCannotBeReplaced() = runBlocking {
        val journal = Journal(); val transport = Transport(journal); val repository = ProcessingRepository(transport, journal)
        val value = StoredProcessingIntent(account, 4, intent)
        repository.submit(value, null, "not-persisted") { false }
        assertEquals(value, journal.value); assertTrue(transport.writes.isEmpty())
        assertTrue(runCatching { repository.submit(value.copy(intent = intent.copy(operationKey = "new")), value, "token") { true } }.isFailure)
        assertTrue(runCatching { repository.discardRefused(value) }.isFailure)
        assertTrue(transport.writes.isEmpty())
        journal.value = null; journal.broken = true
        assertTrue(runCatching { repository.submit(value, null, "token") { true } }.isFailure)
        assertTrue(transport.writes.isEmpty())
    }
    @Test fun knownRefusalKeepsIntentForExplicitEditOrDiscardWithoutTreatingItAsSuccess() = runBlocking {
        val journal = Journal(); val transport = Transport(journal); val repository = ProcessingRepository(transport, journal)
        val value = StoredProcessingIntent(account, 4, intent)
        transport.result = ProcessingWriteResult.Rejected("state_conflict")
        repository.submit(value, null, "token") { true }
        val refused = value.copy(rejected = "state_conflict")
        assertEquals(refused, journal.value)
        repository.read(account, 4, "token")
        assertEquals(1, transport.writes.size)
        val edited = value.copy(intent = intent.copy(operationKey = "edited", source = intent.source.copy(fence = "c".repeat(64))))
        transport.result = ProcessingWriteResult.Unknown(FailureKind.Timeout)
        repository.submit(edited, refused, "token") { true }
        assertEquals(edited, journal.value)
        assertTrue(runCatching { repository.discardRefused(refused) }.isFailure)
        assertEquals(edited, journal.value)
    }
}
