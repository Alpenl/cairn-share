package com.alpenl.cairn.share

import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.core.content.FileProvider
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.lifecycleScope
import com.alpenl.cairn.share.network.ApiDebugClient
import com.alpenl.cairn.share.network.AppUpdateInfo
import com.alpenl.cairn.share.network.UpdateApiClient
import com.alpenl.cairn.share.ui.theme.CairnShareTheme
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

class LauncherActivity : ComponentActivity() {
    private var updateJob: Job? = null
    private var pendingInstallFile: File? = null
    private var pendingInstallUpdate: AppUpdateInfo? = null
    private lateinit var viewModel: CairnLinksViewModel

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        val apiBaseUrl = normalizedExtra(
            key = ShareActivity.EXTRA_API_BASE_URL,
            fallback = BuildConfig.CAIRN_SHARE_API_BASE_URL,
        ).trimEnd('/')
        val releasesApiUrl = normalizedExtra(
            key = ShareActivity.EXTRA_RELEASES_API_URL,
            fallback = BuildConfig.CAIRN_SHARE_RELEASES_API_URL,
        )
        val factory = CairnLinksViewModelFactory(
            repository = LinkRepository(apiBaseUrl),
            updateApiClient = UpdateApiClient(releasesApiUrl),
            settingsStore = SharePreferencesStore(this),
            pendingUploadStore = PendingUploadStore(this),
            apiDebugClient = ApiDebugClient(apiBaseUrl),
            apiBaseUrl = apiBaseUrl,
            releasesApiUrl = releasesApiUrl,
            currentVersionName = BuildConfig.VERSION_NAME,
            currentVersionCode = BuildConfig.VERSION_CODE,
        )
        viewModel = ViewModelProvider(this, factory)[CairnLinksViewModel::class.java]

        setContent {
            CairnShareTheme {
                CairnLinksApp(
                    viewModel = viewModel,
                    onOpenExternal = ::openExternal,
                    onCopy = ::copyLink,
                    onInstallUpdate = ::openUpdate,
                )
            }
        }
    }

    override fun onDestroy() {
        updateJob?.cancel()
        super.onDestroy()
    }

    override fun onResume() {
        super.onResume()
        val file = pendingInstallFile ?: return
        val update = pendingInstallUpdate ?: return
        if (canRequestPackageInstalls()) {
            pendingInstallFile = null
            pendingInstallUpdate = null
            installDownloadedUpdate(update, file)
        }
    }

    private fun normalizedExtra(key: String, fallback: String): String =
        intent.getStringExtra(key)?.trim()?.takeIf(String::isNotEmpty) ?: fallback

    private fun openExternal(url: String) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
        } catch (_: ActivityNotFoundException) {
            Toast.makeText(this, R.string.library_open_failed, Toast.LENGTH_SHORT).show()
        } catch (_: SecurityException) {
            Toast.makeText(this, R.string.library_open_failed, Toast.LENGTH_SHORT).show()
        }
    }

    private fun copyLink(url: String) {
        val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        clipboard.setPrimaryClip(ClipData.newPlainText(getString(R.string.app_name), url))
        Toast.makeText(this, R.string.library_copied, Toast.LENGTH_SHORT).show()
    }

    private fun openUpdate() {
        when (val state = viewModel.uiState.updateState) {
            is AppUpdateState.Available -> downloadAndInstallUpdate(state.update)
            is AppUpdateState.InstallFailed -> downloadAndInstallUpdate(state.update)
            is AppUpdateState.InstallPermissionRequired -> openInstallPermissionSettings(state.update)
            AppUpdateState.Checking,
            is AppUpdateState.Downloading,
            AppUpdateState.Failed,
            AppUpdateState.Hidden,
            is AppUpdateState.InstallStarted,
            AppUpdateState.UpToDate -> Unit
        }
    }

    private fun downloadAndInstallUpdate(update: AppUpdateInfo) {
        updateJob?.cancel()
        pendingInstallFile = null
        pendingInstallUpdate = null
        viewModel.setUpdateState(AppUpdateState.Downloading(update))
        updateJob = lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) {
                UpdateApkDownloader().download(
                    downloadUrl = update.downloadUrl,
                    versionName = update.versionName,
                    updateDir = File(cacheDir, "updates"),
                )
            }
            if (!isActive) return@launch
            when (result) {
                is UpdateDownloadResult.Downloaded -> installDownloadedUpdate(update, result.file)
                UpdateDownloadResult.Failed -> viewModel.setUpdateState(AppUpdateState.InstallFailed(update))
            }
        }
    }

    private fun installDownloadedUpdate(update: AppUpdateInfo, file: File) {
        if (!canRequestPackageInstalls()) {
            pendingInstallFile = file
            pendingInstallUpdate = update
            viewModel.setUpdateState(AppUpdateState.InstallPermissionRequired(update))
            openInstallPermissionSettings(update)
            return
        }

        val apkUri = FileProvider.getUriForFile(this, "$packageName.fileprovider", file)
        val installIntent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(apkUri, APK_MIME_TYPE)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            putExtra(Intent.EXTRA_NOT_UNKNOWN_SOURCE, true)
            putExtra(Intent.EXTRA_RETURN_RESULT, true)
        }

        try {
            startActivity(installIntent)
            viewModel.setUpdateState(AppUpdateState.InstallStarted(update))
        } catch (_: ActivityNotFoundException) {
            viewModel.setUpdateState(AppUpdateState.InstallFailed(update))
        } catch (_: SecurityException) {
            viewModel.setUpdateState(AppUpdateState.InstallFailed(update))
        }
    }

    private fun canRequestPackageInstalls(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.O || packageManager.canRequestPackageInstalls()

    private fun openInstallPermissionSettings(update: AppUpdateInfo) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        try {
            startActivity(
                Intent(
                    Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:$packageName"),
                ),
            )
        } catch (_: ActivityNotFoundException) {
            pendingInstallFile = null
            pendingInstallUpdate = null
            viewModel.setUpdateState(AppUpdateState.InstallFailed(update))
        } catch (_: SecurityException) {
            pendingInstallFile = null
            pendingInstallUpdate = null
            viewModel.setUpdateState(AppUpdateState.InstallFailed(update))
        }
    }

    private companion object {
        const val APK_MIME_TYPE = "application/vnd.android.package-archive"
    }
}
