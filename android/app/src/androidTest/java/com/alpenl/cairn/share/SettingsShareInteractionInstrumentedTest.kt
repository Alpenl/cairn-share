package com.alpenl.cairn.share

import android.content.Intent
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.alpenl.cairn.share.contract.UrlCandidate
import com.alpenl.cairn.share.ui.theme.CairnShareTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.atomic.AtomicInteger

/** Isolated real composables: synthetic data and callbacks, no HTTP or persistent mutations. */
@RunWith(AndroidJUnit4::class)
class SettingsShareInteractionInstrumentedTest {
    @get:Rule val compose = createEmptyComposeRule()

    private fun host(content: @Composable () -> Unit): ActivityScenario<ShareActivity> {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val intent = Intent(context, ShareActivity::class.java).apply {
            action = Intent.ACTION_SEND
            type = "text/plain"
            putExtra(Intent.EXTRA_TEXT, "https://example.com/isolated-ui")
            putExtra(ShareActivity.EXTRA_API_BASE_URL, "http://127.0.0.1:1")
        }
        return ActivityScenario.launch<ShareActivity>(intent).also { scenario ->
            scenario.onActivity { activity ->
                activity.setContent {
                    CairnShareTheme {
                        Surface(Modifier.fillMaxSize()) { content() }
                    }
                }
            }
            compose.waitForIdle()
        }
    }

    @Test fun settingsHaveOneTogglePerPreferenceAndOnlyActionableSyncWork() {
        val changes = AtomicInteger()
        val retries = AtomicInteger()
        val state = mutableStateOf(CairnLinksUiState(
            apiBaseUrl = "https://example.com", releasesApiUrl = "https://example.com/latest",
            currentVersionName = "test", currentVersionCode = 1,
            pendingUploadsLoaded = true, preferencesLoaded = true,
        ))
        host {
            SettingsScreen(state.value,
                onCloseAfterSaveChange = { enabled ->
                    changes.incrementAndGet()
                    state.value = state.value.copy(preferences = state.value.preferences.copy(closeAfterSave = enabled))
                },
                onPreserveCompleteUrlChange = {}, onApiTokenChange = {}, onOpenUploads = {}, onOpenConsole = {},
                onOpenUpdate = {}, onOpenAbout = {}, onClearOffline = {},
                onFlushPersonal = { retries.incrementAndGet() }, onOpenOffline = {},
                onAutomaticSync = { enabled -> state.value = state.value.copy(preferences = state.value.preferences.copy(automaticSync = enabled)) },
                onImagesWifiOnly = { enabled -> state.value = state.value.copy(preferences = state.value.preferences.copy(imagesWifiOnly = enabled)) })
        }.use {
            compose.onAllNodes(isToggleable(), useUnmergedTree = true).assertCountEquals(4)
            compose.onNodeWithTag("settings_auto_sync").performScrollTo().assertIsOn().performClick()
            compose.onNodeWithTag("settings_auto_sync").assertIsOff()
            compose.onNodeWithTag("settings_wifi_images").performScrollTo().assertIsOn().performClick()
            compose.onNodeWithTag("settings_wifi_images").assertIsOff()
            compose.onNodeWithTag("settings_close_after_save").performScrollTo().assertIsOn().performClick()
            compose.onNodeWithTag("settings_close_after_save").assertIsOff()
            assertEquals(1, changes.get())
            compose.onNodeWithTag("settings_personal_sync").performScrollTo()
                .assert(SemanticsMatcher.keyNotDefined(SemanticsActions.OnClick))
            compose.onNodeWithText("没有待同步的个人标签修改").assertExists()
            compose.onNodeWithTag("settings_debug").assertDoesNotExist()
            compose.onNodeWithTag("settings_advanced").performScrollTo().performClick()
            compose.onNodeWithTag("settings_debug").performScrollTo().assertIsDisplayed()
            compose.runOnIdle { state.value = state.value.copy(personalTagPendingCount = 1) }
            compose.onNodeWithTag("settings_personal_sync").performScrollTo().performClick()
            compose.onNodeWithTag("settings_token_input").assertIsDisplayed()
            assertEquals("Missing credentials must open connection settings instead of retrying", 0, retries.get())
        }
    }

    @Test fun narrowLargeTextShareKeepsSaveReachableAndAllowsCloseOnlyAfterDurableSave() {
        val selected = mutableStateOf(0)
        val submitting = mutableStateOf(false)
        val completed = mutableStateOf(false)
        val cancelled = AtomicInteger()
        val saved = AtomicInteger()
        val candidates = listOf(
            UrlCandidate("https://example.com/first?source=share#details", "example.com/first"),
            UrlCandidate("https://example.com/second?source=share#details", "example.com/second"),
        )
        host {
            CompositionLocalProvider(LocalDensity provides Density(LocalDensity.current.density, 2f)) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.BottomCenter) {
                    SaveLinkSheetContent(
                        title = "保存链接", subtitle = "加入你的阅读收藏", candidates = candidates,
                        selectedIndex = selected.value, selectedLabel = candidates[selected.value].displayLabel,
                        onSelectCandidate = { selected.value = it }, manualUrl = null, onManualUrlChange = {},
                        note = "", onNoteChange = {}, statusText = "", submitting = submitting.value,
                        completed = completed.value, submitEnabled = true, preserveCompleteUrl = true,
                        onCancel = { cancelled.incrementAndGet() }, onSave = { saved.incrementAndGet() },
                        modifier = Modifier.width(320.dp).height(480.dp),
                    )
                }
            }
        }.use {
            compose.onNodeWithTag("candidate_0").assertIsSelected()
            compose.onNodeWithTag("candidate_1").assertIsNotSelected().performScrollTo().performClick()
            compose.onNodeWithTag("candidate_1").assertIsSelected()
            compose.onNodeWithTag("share_url_toggle").performScrollTo().performClick()
            compose.onNodeWithTag("share_complete_url").assertTextContains(candidates[1].submissionValue)
            compose.onNodeWithTag("save").assertIsDisplayed().assertHeightIsAtLeast(48.dp).performClick()
            assertEquals(1, saved.get())
            compose.runOnIdle { submitting.value = true }
            compose.onNodeWithTag("save").assertIsNotEnabled()
            compose.onNodeWithTag("share_cancel").assertIsNotEnabled()
            compose.runOnIdle { completed.value = true }
            compose.onNodeWithTag("save").assertIsNotEnabled()
            compose.onNodeWithTag("share_cancel").assertIsEnabled().performClick()
            assertEquals(1, cancelled.get())
        }
    }
}
