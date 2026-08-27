package com.alpenl.cairn.share

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

private val Context.cairnSharePreferences by preferencesDataStore("cairn_share_preferences")

internal data class SharePreferences(
    val closeAfterSave: Boolean = true,
    val preserveCompleteUrl: Boolean = true,
    val apiToken: String = "",
    val lastRoute: String = "library",
    val lastFilter: String = "all",
    val lastSearchQuery: String = "",
)

internal class SharePreferencesStore(context: Context) {
    private val dataStore = context.applicationContext.cairnSharePreferences

    val preferences: Flow<SharePreferences> = dataStore.data.map { values ->
        SharePreferences(
            closeAfterSave = values[CloseAfterSaveKey] ?: true,
            preserveCompleteUrl = values[PreserveCompleteUrlKey] ?: true,
            apiToken = values[ApiTokenKey].orEmpty(),
            lastRoute = values[LastRouteKey] ?: "library",
            lastFilter = values[LastFilterKey] ?: "all",
            lastSearchQuery = values[LastSearchQueryKey].orEmpty(),
        )
    }

    suspend fun setCloseAfterSave(value: Boolean) {
        dataStore.edit { it[CloseAfterSaveKey] = value }
    }

    suspend fun setPreserveCompleteUrl(value: Boolean) {
        dataStore.edit { it[PreserveCompleteUrlKey] = value }
    }

    suspend fun setApiToken(value: String) {
        dataStore.edit { it[ApiTokenKey] = value.trim() }
    }

    suspend fun setLastRoute(value: String) {
        dataStore.edit { it[LastRouteKey] = value }
    }

    suspend fun setLastFilter(value: String) {
        dataStore.edit { it[LastFilterKey] = value }
    }

    suspend fun setLastSearchQuery(value: String) {
        dataStore.edit { it[LastSearchQueryKey] = value }
    }

    private companion object {
        val CloseAfterSaveKey = booleanPreferencesKey("close_after_save")
        val PreserveCompleteUrlKey = booleanPreferencesKey("preserve_complete_url")
        val ApiTokenKey = stringPreferencesKey("api_token")
        val LastRouteKey = stringPreferencesKey("last_route")
        val LastFilterKey = stringPreferencesKey("last_filter")
        val LastSearchQueryKey = stringPreferencesKey("last_search_query")
    }
}
