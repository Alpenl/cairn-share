package com.alpenl.cairn.share

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

private val Context.cairnSharePreferences by preferencesDataStore("cairn_share_preferences")

internal data class SharePreferences(
    val closeAfterSave: Boolean = true,
    val preserveCompleteUrl: Boolean = true,
    val apiToken: String = "",
    val apiTokenRevision: Long = 0,
    val lastRoute: String = "library",
    val lastFilter: String = "all",
    val lastSearchQuery: String = "",
    val automaticSync: Boolean = true,
    val imagesWifiOnly: Boolean = true,
    val storageLimitMb: Long = 1024,
)

internal class SharePreferencesStore(private val dataStore: DataStore<Preferences>) {
    constructor(context: Context) : this(context.applicationContext.cairnSharePreferences)

    val preferences: Flow<SharePreferences> = dataStore.data.map { values ->
        SharePreferences(
            closeAfterSave = values[CloseAfterSaveKey] ?: true,
            preserveCompleteUrl = values[PreserveCompleteUrlKey] ?: true,
            apiToken = values[ApiTokenKey].orEmpty(),
            apiTokenRevision = values[ApiTokenRevisionKey] ?: 0,
            lastRoute = values[LastRouteKey] ?: "library",
            lastFilter = values[LastFilterKey] ?: "all",
            lastSearchQuery = values[LastSearchQueryKey].orEmpty(),
            automaticSync = values[AutomaticSyncKey] ?: true,
            imagesWifiOnly = values[ImagesWifiOnlyKey] ?: true,
            storageLimitMb = values[StorageLimitMbKey] ?: 1024,
        )
    }

    suspend fun setCloseAfterSave(value: Boolean) {
        dataStore.edit { it[CloseAfterSaveKey] = value }
    }

    suspend fun setPreserveCompleteUrl(value: Boolean) {
        dataStore.edit { it[PreserveCompleteUrlKey] = value }
    }

    suspend fun setApiToken(value: String): Long {
        val saved = dataStore.edit {
            it[ApiTokenKey] = value.trim()
            it[ApiTokenRevisionKey] = (it[ApiTokenRevisionKey] ?: 0) + 1
        }
        return saved[ApiTokenRevisionKey]!!
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

    suspend fun setAutomaticSync(value: Boolean) { dataStore.edit { it[AutomaticSyncKey] = value } }
    suspend fun setImagesWifiOnly(value: Boolean) { dataStore.edit { it[ImagesWifiOnlyKey] = value } }
    suspend fun setStorageLimitMb(value: Long) { require(value in listOf(256L, 512L, 1024L, 2048L)); dataStore.edit { it[StorageLimitMbKey] = value } }

    private companion object {
        val AutomaticSyncKey = booleanPreferencesKey("automatic_library_sync")
        val ImagesWifiOnlyKey = booleanPreferencesKey("library_images_wifi_only")
        val StorageLimitMbKey = longPreferencesKey("library_storage_limit_mb")
        val CloseAfterSaveKey = booleanPreferencesKey("close_after_save")
        val PreserveCompleteUrlKey = booleanPreferencesKey("preserve_complete_url")
        val ApiTokenKey = stringPreferencesKey("api_token")
        val ApiTokenRevisionKey = longPreferencesKey("api_token_revision")
        val LastRouteKey = stringPreferencesKey("last_route")
        val LastFilterKey = stringPreferencesKey("last_filter")
        val LastSearchQueryKey = stringPreferencesKey("last_search_query")
    }
}
