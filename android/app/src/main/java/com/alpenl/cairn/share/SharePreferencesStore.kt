package com.alpenl.cairn.share

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

private val Context.cairnSharePreferences by preferencesDataStore("cairn_share_preferences")

internal data class SharePreferences(
    val closeAfterSave: Boolean = true,
    val preserveCompleteUrl: Boolean = true,
)

internal class SharePreferencesStore(context: Context) {
    private val dataStore = context.applicationContext.cairnSharePreferences

    val preferences: Flow<SharePreferences> = dataStore.data.map { values ->
        SharePreferences(
            closeAfterSave = values[CloseAfterSaveKey] ?: true,
            preserveCompleteUrl = values[PreserveCompleteUrlKey] ?: true,
        )
    }

    suspend fun setCloseAfterSave(value: Boolean) {
        dataStore.edit { it[CloseAfterSaveKey] = value }
    }

    suspend fun setPreserveCompleteUrl(value: Boolean) {
        dataStore.edit { it[PreserveCompleteUrlKey] = value }
    }

    private companion object {
        val CloseAfterSaveKey = booleanPreferencesKey("close_after_save")
        val PreserveCompleteUrlKey = booleanPreferencesKey("preserve_complete_url")
    }
}
