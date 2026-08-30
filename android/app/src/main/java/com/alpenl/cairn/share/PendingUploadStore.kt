package com.alpenl.cairn.share

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.alpenl.cairn.share.network.FailureKind
import java.util.UUID
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import org.json.JSONArray
import org.json.JSONObject

private val Context.cairnPendingUploads by preferencesDataStore("cairn_pending_uploads")

internal data class PendingUpload(
    val id: String,
    val url: String,
    val note: String,
    val createdAtEpochMillis: Long,
    val attemptCount: Int = 0,
    val lastAttemptAtEpochMillis: Long? = null,
    val lastFailure: FailureKind? = null,
)

internal class PendingUploadStore(context: Context) {
    private val dataStore = context.applicationContext.cairnPendingUploads

    val uploads: Flow<List<PendingUpload>> = dataStore.data.map { values ->
        PendingUploadJson.decode(values[UploadsKey].orEmpty())
    }

    suspend fun enqueue(
        url: String,
        note: String,
        id: String = UUID.randomUUID().toString(),
        nowEpochMillis: Long = System.currentTimeMillis(),
    ): PendingUpload {
        val upload = PendingUpload(
            id = id,
            url = url,
            note = note,
            createdAtEpochMillis = nowEpochMillis,
        )
        dataStore.edit { values ->
            val current = PendingUploadJson.decode(values[UploadsKey].orEmpty())
            values[UploadsKey] = PendingUploadJson.encode(
                (current.filterNot { it.id == upload.id } + upload)
                    .sortedBy(PendingUpload::createdAtEpochMillis),
            )
        }
        return upload
    }

    suspend fun remove(id: String) {
        dataStore.edit { values ->
            val current = PendingUploadJson.decode(values[UploadsKey].orEmpty())
            values[UploadsKey] = PendingUploadJson.encode(current.filterNot { it.id == id })
        }
    }

    suspend fun recordFailure(
        id: String,
        failure: FailureKind,
        nowEpochMillis: Long = System.currentTimeMillis(),
    ) {
        dataStore.edit { values ->
            val current = PendingUploadJson.decode(values[UploadsKey].orEmpty())
            values[UploadsKey] = PendingUploadJson.encode(
                current.map { upload ->
                    if (upload.id == id) {
                        upload.copy(
                            attemptCount = upload.attemptCount + 1,
                            lastAttemptAtEpochMillis = nowEpochMillis,
                            lastFailure = failure,
                        )
                    } else {
                        upload
                    }
                },
            )
        }
    }

    suspend fun clear() {
        dataStore.edit { it.remove(UploadsKey) }
    }

    private companion object {
        val UploadsKey = stringPreferencesKey("uploads_json")
    }
}

internal object PendingUploadJson {
    fun encode(uploads: List<PendingUpload>): String =
        JSONArray().apply {
            uploads.forEach { upload ->
                put(
                    JSONObject()
                        .put("id", upload.id)
                        .put("url", upload.url)
                        .put("note", upload.note)
                        .put("created_at", upload.createdAtEpochMillis)
                        .put("attempt_count", upload.attemptCount)
                        .put("last_attempt_at", upload.lastAttemptAtEpochMillis ?: JSONObject.NULL)
                        .put("last_failure", upload.lastFailure?.name ?: JSONObject.NULL),
                )
            }
        }.toString()

    fun decode(value: String): List<PendingUpload> {
        if (value.isBlank()) return emptyList()
        return runCatching {
            val array = JSONArray(value)
            buildList {
                for (index in 0 until array.length()) {
                    val item = array.optJSONObject(index) ?: continue
                    val id = item.optString("id").trim()
                    val url = item.optString("url")
                    val createdAt = item.optLong("created_at", -1L)
                    if (id.isBlank() || url.isBlank() || createdAt < 0L) continue
                    add(
                        PendingUpload(
                            id = id,
                            url = url,
                            note = item.optString("note"),
                            createdAtEpochMillis = createdAt,
                            attemptCount = item.optInt("attempt_count", 0).coerceAtLeast(0),
                            lastAttemptAtEpochMillis = item.optionalLong("last_attempt_at"),
                            lastFailure = item.optionalString("last_failure")
                                ?.let { stored -> FailureKind.entries.firstOrNull { it.name == stored } },
                        ),
                    )
                }
            }.sortedBy(PendingUpload::createdAtEpochMillis)
        }.getOrDefault(emptyList())
    }

    private fun JSONObject.optionalLong(name: String): Long? =
        if (isNull(name) || !has(name)) null else optLong(name).takeIf { it >= 0L }

    private fun JSONObject.optionalString(name: String): String? =
        if (isNull(name) || !has(name)) null else optString(name).takeIf(String::isNotBlank)
}
