package com.alpenl.cairn.share.network

/** No automatic drainer: these explicit actions may cause later paid work. */
internal data class StoredProcessingIntent(val accountKey: String, val linkId: Int, val intent: ProcessingIntent, val rejected: String? = null)
internal interface ProcessingJournal {
    suspend fun load(accountKey: String, linkId: Int): StoredProcessingIntent?
    suspend fun prepare(value: StoredProcessingIntent, expected: StoredProcessingIntent?)
    suspend fun reject(value: StoredProcessingIntent, code: String)
    suspend fun acknowledge(value: StoredProcessingIntent)
    suspend fun discardRefused(value: StoredProcessingIntent)
}
internal data class ProcessingRead(val pending: StoredProcessingIntent?, val result: RunHistoryResult<ProcessingStatus>)
internal class ProcessingRepository(private val transport: ProcessingTransport, private val journal: ProcessingJournal) {
    suspend fun discardRefused(value: StoredProcessingIntent) {
        require(value.rejected != null)
        journal.discardRefused(value)
    }
    /** Loading a pending/unknown intent never sends it. Journal corruption is
     * surfaced instead of being interpreted as an empty queue. */
    suspend fun read(account: String, id: Int, token: String): ProcessingRead {
        val pending = journal.load(account, id)
        return ProcessingRead(pending, transport.status(id, token))
    }

    /** Persist before the first network byte. An account/deletion guard is
     * checked after persistence so a suspended prepare cannot start a foreign
     * action. A response for the old account can settle only its old journal. */
    suspend fun submit(value: StoredProcessingIntent, expected: StoredProcessingIntent?, token: String,
        permitted: () -> Boolean): ProcessingWriteResult {
        journal.prepare(value, expected)
        if (!permitted()) return ProcessingWriteResult.Unknown(FailureKind.Server)
        val result = transport.submit(value.linkId, token, value.intent)
        when (result) {
            is ProcessingWriteResult.Confirmed -> journal.acknowledge(value)
            is ProcessingWriteResult.Rejected -> journal.reject(value, result.code)
            is ProcessingWriteResult.Unknown -> Unit
        }
        return result
    }
}
