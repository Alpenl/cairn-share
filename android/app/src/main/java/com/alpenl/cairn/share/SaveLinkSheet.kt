package com.alpenl.cairn.share

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.ModalBottomSheetProperties
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.SheetValue
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.alpenl.cairn.share.contract.UrlCandidate

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ShareBottomSheetScreen(
    title: String,
    subtitle: String,
    candidates: List<UrlCandidate>,
    selectedIndex: Int,
    note: String,
    statusText: String,
    submitting: Boolean,
    completed: Boolean = false,
    settingsLoaded: Boolean = true,
    preserveCompleteUrl: Boolean,
    onSelectCandidate: (Int) -> Unit,
    onNoteChange: (String) -> Unit,
    onSave: () -> Unit,
    onCancel: () -> Unit,
) {
    val selected = candidates.getOrNull(selectedIndex)
    val submittingNow by rememberUpdatedState(submitting && !completed)
    ModalBottomSheet(
        onDismissRequest = { if (!submittingNow) onCancel() },
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true,
            confirmValueChange = { it != SheetValue.Hidden || !submittingNow }),
        properties = ModalBottomSheetProperties(shouldDismissOnBackPress = !submitting || completed),
        containerColor = MaterialTheme.colorScheme.surface,
    ) {
        SaveLinkSheetContent(
            title = title, subtitle = subtitle, candidates = candidates, selectedIndex = selectedIndex,
            selectedLabel = selected?.displayLabel, onSelectCandidate = onSelectCandidate,
            manualUrl = null, onManualUrlChange = {}, note = note, onNoteChange = onNoteChange,
            statusText = statusText, submitting = submitting, completed = completed,
            submitEnabled = selected != null && settingsLoaded && !submitting && !completed,
            preserveCompleteUrl = preserveCompleteUrl, onCancel = onCancel, onSave = onSave,
            modifier = Modifier.navigationBarsPadding(),
        )
    }
}

@Composable
internal fun SaveLinkSheetContent(
    title: String,
    subtitle: String,
    candidates: List<UrlCandidate>,
    selectedIndex: Int,
    selectedLabel: String?,
    onSelectCandidate: (Int) -> Unit,
    manualUrl: String?,
    onManualUrlChange: (String) -> Unit,
    note: String,
    onNoteChange: (String) -> Unit,
    statusText: String,
    submitting: Boolean,
    completed: Boolean,
    submitEnabled: Boolean,
    preserveCompleteUrl: Boolean,
    onCancel: () -> Unit,
    onSave: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val focus = LocalFocusManager.current
    val editable = !submitting && !completed
    val rawUrl = manualUrl ?: candidates.getOrNull(selectedIndex)?.submissionValue
    val savedUrl = rawUrl?.let { if (preserveCompleteUrl) it else removeQueryAndFragment(it) }
    var urlExpanded by rememberSaveable(rawUrl, preserveCompleteUrl) { mutableStateOf(false) }
    Column(modifier = modifier.fillMaxWidth().imePadding()) {
        Column(modifier = Modifier.fillMaxWidth().weight(1f, fill = false)
            .verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Text(title, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold, modifier = Modifier.semantics { heading() })
            Text(subtitle, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (manualUrl != null) {
                OutlinedTextField(value = manualUrl, onValueChange = onManualUrlChange,
                    label = { Text("链接") }, placeholder = { Text("https://example.com/article") },
                    enabled = editable, minLines = 1, maxLines = 3,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Next),
                    shape = RoundedCornerShape(12.dp), modifier = Modifier.fillMaxWidth().testTag("manual_url"))
            } else if (candidates.size > 1) {
                Text("选择要保存的链接", style = MaterialTheme.typography.labelLarge)
                LazyColumn(modifier = Modifier.fillMaxWidth().heightIn(max = 220.dp).selectableGroup(),
                    verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(candidates.indices.toList()) { index ->
                        CandidatePickRow(label = candidates[index].displayLabel, selected = selectedIndex == index,
                            enabled = editable, onClick = { onSelectCandidate(index) }, modifier = Modifier.testTag("candidate_$index"))
                    }
                }
            }
            if (selectedLabel != null || !savedUrl.isNullOrBlank()) {
                Surface(shape = RoundedCornerShape(16.dp), color = MaterialTheme.colorScheme.surfaceVariant,
                    modifier = Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        selectedLabel?.let {
                            Text("已选择", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            Text(it, maxLines = 2, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyLarge,
                                modifier = Modifier.testTag("selected_label"))
                        }
                        if (!savedUrl.isNullOrBlank()) {
                            TextButton(onClick = { urlExpanded = !urlExpanded }, modifier = Modifier.heightIn(min = 48.dp).testTag("share_url_toggle")
                                .semantics { stateDescription = if (urlExpanded) "已展开" else "已折叠" }) {
                                Text(if (urlExpanded) "收起链接" else if (preserveCompleteUrl) "查看完整链接" else "查看将保存的链接")
                                Spacer(Modifier.width(8.dp))
                                Icon(if (urlExpanded) CairnIcons.Down else CairnIcons.Chevron, contentDescription = null, modifier = Modifier.size(18.dp))
                            }
                            if (urlExpanded) SelectionContainer {
                                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                    Text(savedUrl, style = MaterialTheme.typography.bodySmall, modifier = Modifier.testTag("share_complete_url"))
                                    if (rawUrl != savedUrl) {
                                        Text("原始链接", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                        Text(rawUrl.orEmpty(), style = MaterialTheme.typography.bodySmall)
                                    }
                                }
                            }
                            if (!preserveCompleteUrl) Text("保存时会移除链接参数与页面定位。", style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            }
            OutlinedTextField(value = note, onValueChange = onNoteChange, label = { Text("备注，可选") },
                placeholder = { Text("留下一句收藏原因") }, supportingText = { Text("${note.length} / $MAX_NOTE_LENGTH") },
                isError = note.length > MAX_NOTE_LENGTH, enabled = editable, minLines = 2, maxLines = 4,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done), keyboardActions = KeyboardActions(onDone = { focus.clearFocus() }),
                shape = RoundedCornerShape(12.dp), modifier = Modifier.fillMaxWidth().testTag("note"))
        }
        Surface(color = MaterialTheme.colorScheme.surface, modifier = Modifier.fillMaxWidth()) {
            Column {
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                Column(Modifier.padding(horizontal = 20.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (statusText.isNotBlank()) Text(statusText, style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.testTag("status").semantics { liveRegion = LiveRegionMode.Polite })
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        TextButton(onClick = { if (!submitting || completed) { focus.clearFocus(); onCancel() } }, enabled = !submitting || completed,
                            shape = RoundedCornerShape(12.dp), modifier = Modifier.weight(1f).heightIn(min = 48.dp).testTag("share_cancel")) {
                            Text(if (completed) "关闭" else stringResource(R.string.share_cancel))
                        }
                        Button(onClick = { focus.clearFocus(); onSave() }, enabled = submitEnabled && editable,
                            shape = RoundedCornerShape(12.dp), modifier = Modifier.weight(1.6f).heightIn(min = 48.dp).testTag("save")) {
                            if (submitting && !completed) CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(18.dp))
                            else Icon(Icons.Default.Check, contentDescription = null, modifier = Modifier.size(18.dp))
                            Spacer(Modifier.width(8.dp))
                            Text(if (completed) "已收下" else if (submitting) "保存中" else stringResource(R.string.share_save))
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun CandidatePickRow(label: String, selected: Boolean, enabled: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier) {
    Surface(shape = RoundedCornerShape(12.dp), color = if (selected) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surface,
        border = BorderStroke(1.dp, if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant),
        modifier = modifier.fillMaxWidth().heightIn(min = 48.dp).selectable(selected = selected, enabled = enabled, role = Role.RadioButton, onClick = onClick)) {
        Row(Modifier.padding(horizontal = 12.dp, vertical = 10.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
            RadioButton(selected = selected, onClick = null, enabled = enabled)
            Text(label, maxLines = 2, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
        }
    }
}
