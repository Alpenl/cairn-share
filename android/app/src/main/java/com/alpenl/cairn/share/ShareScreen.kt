package com.alpenl.cairn.share

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

@Composable
internal fun ShareScreen(
    model: ShareScreenModel,
    onSelectRow: (Int) -> Unit,
    onNoteChange: (String) -> Unit,
    onSave: () -> Unit,
    updateState: AppUpdateState,
    currentVersionName: String,
    onCheckUpdate: () -> Unit,
    onOpenUpdate: () -> Unit,
    onClose: () -> Unit,
) {
    Surface(
        color = MaterialTheme.colorScheme.background,
        modifier = Modifier
            .fillMaxSize()
            .imePadding(),
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .statusBarsPadding()
                .navigationBarsPadding()
                .padding(horizontal = 20.dp, vertical = 18.dp),
            verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            Header()
            UpdateCard(
                updateState = updateState,
                currentVersionName = currentVersionName,
                onCheckUpdate = onCheckUpdate,
                onOpenUpdate = onOpenUpdate,
            )

            Surface(
                shape = MaterialTheme.shapes.extraLarge,
                color = MaterialTheme.colorScheme.surface,
                tonalElevation = 2.dp,
                shadowElevation = 4.dp,
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f, fill = false),
            ) {
                Column(
                    modifier = Modifier.padding(18.dp),
                    verticalArrangement = Arrangement.spacedBy(16.dp),
                ) {
                    Text(
                        text = stringResource(R.string.share_card_title),
                        style = MaterialTheme.typography.titleLarge,
                        fontWeight = FontWeight.SemiBold,
                    )

                    if (model.rowLabels.isNotEmpty()) {
                        Text(
                            text = stringResource(R.string.share_choose_link),
                            style = MaterialTheme.typography.titleMedium,
                            color = MaterialTheme.colorScheme.secondary,
                        )
                        LazyColumn(
                            modifier = Modifier
                                .fillMaxWidth()
                                .weight(1f, fill = false)
                                .sizeIn(maxHeight = 260.dp),
                            verticalArrangement = Arrangement.spacedBy(10.dp),
                        ) {
                            itemsIndexed(model.rowLabels) { index, label ->
                                CandidateRow(
                                    label = label,
                                    labelMaxLines = model.labelMaxLines,
                                    onClick = { onSelectRow(index) },
                                    modifier = Modifier.testTag("candidate_$index"),
                                )
                            }
                        }
                        HorizontalDivider()
                    }

                    model.selectedLabel?.let { label ->
                        SelectedLinkCard(
                            label = label,
                            labelMaxLines = model.labelMaxLines,
                        )
                        OutlinedTextField(
                            value = model.note,
                            onValueChange = onNoteChange,
                            label = { Text(stringResource(R.string.share_note_label)) },
                            placeholder = { Text(stringResource(R.string.share_note_placeholder)) },
                            enabled = !model.submitting,
                            minLines = 3,
                            modifier = Modifier
                                .fillMaxWidth()
                                .testTag("note"),
                        )
                    }

                    if (model.statusText.isNotEmpty()) {
                        Surface(
                            shape = MaterialTheme.shapes.medium,
                            color = MaterialTheme.colorScheme.secondaryContainer,
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Text(
                                text = model.statusText,
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSecondaryContainer,
                                modifier = Modifier
                                    .padding(14.dp)
                                    .testTag("status"),
                            )
                        }
                    }
                }
            }

            Row(
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth(),
            ) {
                OutlinedButton(
                    onClick = onClose,
                    enabled = model.closeEnabled,
                    modifier = Modifier.weight(1f),
                ) {
                    Text(stringResource(R.string.share_cancel))
                }
                if (model.selectedLabel != null || model.submitting) {
                    Button(
                        onClick = onSave,
                        enabled = model.saveEnabled,
                        modifier = Modifier
                            .weight(1f)
                            .testTag("save"),
                    ) {
                        if (model.submitting) {
                            CircularProgressIndicator(
                                strokeWidth = 2.dp,
                                modifier = Modifier
                                    .padding(end = 8.dp)
                                    .sizeIn(maxWidth = 18.dp, maxHeight = 18.dp),
                            )
                        }
                        Text(stringResource(R.string.share_save))
                    }
                }
            }
        }
    }
}

@Composable
private fun UpdateCard(
    updateState: AppUpdateState,
    currentVersionName: String,
    onCheckUpdate: () -> Unit,
    onOpenUpdate: () -> Unit,
) {
    if (updateState == AppUpdateState.Hidden) return

    Surface(
        shape = MaterialTheme.shapes.extraLarge,
        color = MaterialTheme.colorScheme.tertiaryContainer,
        tonalElevation = 2.dp,
        modifier = Modifier
            .fillMaxWidth()
            .testTag("update_card"),
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            val title = when (updateState) {
                is AppUpdateState.Available -> stringResource(R.string.update_available_title, updateState.update.versionName)
                AppUpdateState.Checking -> stringResource(R.string.update_checking_title)
                AppUpdateState.Failed -> stringResource(R.string.update_failed_title)
                AppUpdateState.Hidden -> ""
                AppUpdateState.UpToDate -> stringResource(R.string.update_latest_title)
            }
            val message = when (updateState) {
                is AppUpdateState.Available -> stringResource(
                    R.string.update_available_message,
                    currentVersionName,
                    updateState.update.versionName,
                )
                AppUpdateState.Checking -> stringResource(R.string.update_checking_message)
                AppUpdateState.Failed -> stringResource(R.string.update_failed_message)
                AppUpdateState.Hidden -> ""
                AppUpdateState.UpToDate -> stringResource(R.string.update_latest_message, currentVersionName)
            }

            Row(
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (updateState == AppUpdateState.Checking) {
                    CircularProgressIndicator(
                        strokeWidth = 2.dp,
                        modifier = Modifier.sizeIn(maxWidth = 18.dp, maxHeight = 18.dp),
                    )
                }
                Text(
                    text = title,
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                    color = MaterialTheme.colorScheme.onTertiaryContainer,
                    modifier = Modifier.testTag("update_title"),
                )
            }
            Text(
                text = message,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onTertiaryContainer,
                modifier = Modifier.testTag("update_message"),
            )
            when (updateState) {
                is AppUpdateState.Available -> Button(
                    onClick = onOpenUpdate,
                    modifier = Modifier.testTag("download_update"),
                ) {
                    Text(stringResource(R.string.update_download))
                }
                AppUpdateState.Failed,
                AppUpdateState.UpToDate -> OutlinedButton(
                    onClick = onCheckUpdate,
                    modifier = Modifier.testTag("check_update"),
                ) {
                    Text(stringResource(R.string.update_check_again))
                }
                AppUpdateState.Checking,
                AppUpdateState.Hidden -> Unit
            }
        }
    }
}

@Composable
private fun Header() {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(
            text = stringResource(R.string.share_title),
            style = MaterialTheme.typography.headlineMedium,
            fontWeight = FontWeight.Bold,
        )
        Text(
            text = stringResource(R.string.share_subtitle),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.secondary,
        )
    }
}

@Composable
private fun CandidateRow(
    label: String,
    labelMaxLines: Int,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Surface(
        shape = MaterialTheme.shapes.large,
        color = MaterialTheme.colorScheme.surfaceVariant,
        modifier = modifier
            .fillMaxWidth()
            .clickable(role = Role.Button, onClick = onClick),
    ) {
        Text(
            text = label,
            maxLines = labelMaxLines,
            overflow = TextOverflow.Ellipsis,
            style = MaterialTheme.typography.bodyLarge,
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 12.dp),
        )
    }
}

@Composable
private fun SelectedLinkCard(
    label: String,
    labelMaxLines: Int,
) {
    Surface(
        shape = MaterialTheme.shapes.large,
        color = MaterialTheme.colorScheme.primaryContainer,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Text(
                text = stringResource(R.string.share_selected_link),
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.onPrimaryContainer,
            )
            Text(
                text = label,
                maxLines = labelMaxLines,
                overflow = TextOverflow.Ellipsis,
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onPrimaryContainer,
                modifier = Modifier.testTag("selected_label"),
            )
        }
    }
}
