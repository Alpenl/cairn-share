package com.alpenl.cairn.share

import com.alpenl.cairn.share.network.AppUpdateInfo

internal sealed interface AppUpdateState {
    data object Hidden : AppUpdateState
    data object Checking : AppUpdateState
    data object UpToDate : AppUpdateState
    data object Failed : AppUpdateState
    data class Available(val update: AppUpdateInfo) : AppUpdateState
}
