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
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.alpenl.cairn.share.contract.UrlDisplayLabel
import com.alpenl.cairn.share.network.LinkFilter
import com.alpenl.cairn.share.network.SavedLink
import java.net.URL

@Composable
internal fun ShareScreen(
    model: ShareScreenModel,
    onSelectRow: (Int) -> Unit,
    onNoteChange: (String) -> Unit,
    onSave: () -> Unit,
    updateState: AppUpdateState,
    currentVersionName: String,
    libraryModel: LinkLibraryModel?,
    onFilterChange: (LinkFilter) -> Unit,
    onSearchQueryChange: (String) -> Unit,
    onSearch: () -> Unit,
    onRefreshLinks: () -> Unit,
    onOpenLink: (SavedLink) -> Unit,
    onToggleLearned: (SavedLink) -> Unit,
    onEditLink: (SavedLink) -> Unit,
    onEditUrlChange: (String) -> Unit,
    onEditNoteChange: (String) -> Unit,
    onSaveEdit: () -> Unit,
    onCancelEdit: () -> Unit,
    onDeleteEditing: () -> Unit,
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
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Header(libraryMode = libraryModel != null)
            UpdateCard(
                updateState = updateState,
                currentVersionName = currentVersionName,
                onCheckUpdate = onCheckUpdate,
                onOpenUpdate = onOpenUpdate,
            )

            if (libraryModel != null) {
                LinkLibraryCard(
                    model = libraryModel,
                    onFilterChange = onFilterChange,
                    onSearchQueryChange = onSearchQueryChange,
                    onSearch = onSearch,
                    onRefreshLinks = onRefreshLinks,
                    onOpenLink = onOpenLink,
                    onToggleLearned = onToggleLearned,
                    onEditLink = onEditLink,
                    onEditUrlChange = onEditUrlChange,
                    onEditNoteChange = onEditNoteChange,
                    onSaveEdit = onSaveEdit,
                    onCancelEdit = onCancelEdit,
                    onDeleteEditing = onDeleteEditing,
                    modifier = Modifier.weight(1f),
                )
                OutlinedButton(
                    onClick = onClose,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(stringResource(R.string.share_cancel))
                }
            } else {
                ShareCaptureCard(
                    model = model,
                    onSelectRow = onSelectRow,
                    onNoteChange = onNoteChange,
                    modifier = Modifier.weight(1f, fill = false),
                )
                ShareFooter(
                    model = model,
                    onSave = onSave,
                    onClose = onClose,
                )
            }
        }
    }
}

@Composable
private fun ShareCaptureCard(
    model: ShareScreenModel,
    onSelectRow: (Int) -> Unit,
    onNoteChange: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    Surface(
        shape = MaterialTheme.shapes.extraLarge,
        color = MaterialTheme.colorScheme.surface,
        tonalElevation = 2.dp,
        shadowElevation = 4.dp,
        modifier = modifier.fillMaxWidth(),
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

            StatusCard(model.statusText)
        }
    }
}

@Composable
private fun LinkLibraryCard(
    model: LinkLibraryModel,
    onFilterChange: (LinkFilter) -> Unit,
    onSearchQueryChange: (String) -> Unit,
    onSearch: () -> Unit,
    onRefreshLinks: () -> Unit,
    onOpenLink: (SavedLink) -> Unit,
    onToggleLearned: (SavedLink) -> Unit,
    onEditLink: (SavedLink) -> Unit,
    onEditUrlChange: (String) -> Unit,
    onEditNoteChange: (String) -> Unit,
    onSaveEdit: () -> Unit,
    onCancelEdit: () -> Unit,
    onDeleteEditing: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Surface(
        shape = MaterialTheme.shapes.extraLarge,
        color = MaterialTheme.colorScheme.surface,
        tonalElevation = 2.dp,
        shadowElevation = 4.dp,
        modifier = modifier.fillMaxWidth(),
    ) {
        Column(
            modifier = Modifier.padding(18.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(
                        text = stringResource(R.string.library_title),
                        style = MaterialTheme.typography.titleLarge,
                        fontWeight = FontWeight.SemiBold,
                    )
                    Text(
                        text = stringResource(R.string.library_hint),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.secondary,
                    )
                }
                TextButton(
                    onClick = onRefreshLinks,
                    enabled = !model.loading,
                    modifier = Modifier.testTag("refresh_links"),
                ) {
                    Text(stringResource(R.string.library_refresh))
                }
            }

            FilterRow(
                selected = model.filter,
                onFilterChange = onFilterChange,
                enabled = !model.loading,
            )

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                OutlinedTextField(
                    value = model.searchQuery,
                    onValueChange = onSearchQueryChange,
                    label = { Text(stringResource(R.string.library_search_label)) },
                    placeholder = { Text(stringResource(R.string.library_search_placeholder)) },
                    singleLine = true,
                    modifier = Modifier
                        .weight(1f)
                        .testTag("library_search"),
                )
                Button(
                    onClick = onSearch,
                    enabled = !model.loading,
                    modifier = Modifier.testTag("library_search_button"),
                ) {
                    Text(stringResource(R.string.library_search))
                }
            }

            StatusCard(
                status = model.statusText,
                tag = "library_status",
            )

            if (model.editing != null) {
                EditLinkCard(
                    model = model.editing,
                    onEditUrlChange = onEditUrlChange,
                    onEditNoteChange = onEditNoteChange,
                    onSaveEdit = onSaveEdit,
                    onCancelEdit = onCancelEdit,
                    onDeleteEditing = onDeleteEditing,
                )
            }

            LazyColumn(
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f, fill = true),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                items(model.items, key = { it.id }) { link ->
                    LinkRow(
                        link = link,
                        onOpenLink = { onOpenLink(link) },
                        onToggleLearned = { onToggleLearned(link) },
                        onEditLink = { onEditLink(link) },
                    )
                }
            }
        }
    }
}

@Composable
private fun FilterRow(
    selected: LinkFilter,
    onFilterChange: (LinkFilter) -> Unit,
    enabled: Boolean,
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        FilterButton(
            label = stringResource(R.string.library_filter_all),
            selected = selected == LinkFilter.All,
            enabled = enabled,
            onClick = { onFilterChange(LinkFilter.All) },
            modifier = Modifier
                .weight(1f)
                .testTag("filter_all"),
        )
        FilterButton(
            label = stringResource(R.string.library_filter_unlearned),
            selected = selected == LinkFilter.Unlearned,
            enabled = enabled,
            onClick = { onFilterChange(LinkFilter.Unlearned) },
            modifier = Modifier
                .weight(1f)
                .testTag("filter_unlearned"),
        )
        FilterButton(
            label = stringResource(R.string.library_filter_learned),
            selected = selected == LinkFilter.Learned,
            enabled = enabled,
            onClick = { onFilterChange(LinkFilter.Learned) },
            modifier = Modifier
                .weight(1f)
                .testTag("filter_learned"),
        )
    }
}

@Composable
private fun FilterButton(
    label: String,
    selected: Boolean,
    enabled: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    if (selected) {
        Button(onClick = onClick, enabled = enabled, modifier = modifier) {
            Text(label, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    } else {
        OutlinedButton(onClick = onClick, enabled = enabled, modifier = modifier) {
            Text(label, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

@Composable
private fun LinkRow(
    link: SavedLink,
    onOpenLink: () -> Unit,
    onToggleLearned: () -> Unit,
    onEditLink: () -> Unit,
) {
    Surface(
        shape = MaterialTheme.shapes.large,
        color = if (link.learned) {
            MaterialTheme.colorScheme.surfaceVariant
        } else {
            MaterialTheme.colorScheme.primaryContainer
        },
        tonalElevation = 1.dp,
        modifier = Modifier
            .fillMaxWidth()
            .testTag("link_${link.id}"),
    ) {
        Column(
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Row(
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.Top,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Column(
                    modifier = Modifier.weight(1f),
                    verticalArrangement = Arrangement.spacedBy(3.dp),
                ) {
                    Text(
                        text = link.displayTitle(),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.SemiBold,
                    )
                    Text(
                        text = link.url,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.secondary,
                    )
                }
                Text(
                    text = if (link.learned) {
                        stringResource(R.string.library_state_learned)
                    } else {
                        stringResource(R.string.library_state_unlearned)
                    },
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.secondary,
                    modifier = Modifier.padding(start = 8.dp),
                )
            }

            if (link.note.isNotBlank()) {
                Text(
                    text = link.note,
                    maxLines = 3,
                    overflow = TextOverflow.Ellipsis,
                    style = MaterialTheme.typography.bodyMedium,
                )
            }

            Text(
                text = stringResource(R.string.library_created_at, link.createdAt.shortDateTime()),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.secondary,
            )

            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                TextButton(onClick = onOpenLink, modifier = Modifier.testTag("open_${link.id}")) {
                    Text(stringResource(R.string.library_open))
                }
                TextButton(onClick = onToggleLearned, modifier = Modifier.testTag("toggle_${link.id}")) {
                    Text(
                        if (link.learned) {
                            stringResource(R.string.library_mark_unlearned)
                        } else {
                            stringResource(R.string.library_mark_learned)
                        },
                    )
                }
                TextButton(onClick = onEditLink, modifier = Modifier.testTag("edit_${link.id}")) {
                    Text(stringResource(R.string.library_edit))
                }
            }
        }
    }
}

@Composable
private fun EditLinkCard(
    model: LinkEditModel,
    onEditUrlChange: (String) -> Unit,
    onEditNoteChange: (String) -> Unit,
    onSaveEdit: () -> Unit,
    onCancelEdit: () -> Unit,
    onDeleteEditing: () -> Unit,
) {
    Surface(
        shape = MaterialTheme.shapes.large,
        color = MaterialTheme.colorScheme.secondaryContainer,
        modifier = Modifier
            .fillMaxWidth()
            .testTag("edit_panel"),
    ) {
        Column(
            modifier = Modifier.padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(
                text = stringResource(R.string.library_edit_title, model.link.id),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.onSecondaryContainer,
            )
            OutlinedTextField(
                value = model.url,
                onValueChange = onEditUrlChange,
                label = { Text(stringResource(R.string.library_url_label)) },
                enabled = !model.saving,
                singleLine = true,
                modifier = Modifier
                    .fillMaxWidth()
                    .testTag("edit_url"),
            )
            OutlinedTextField(
                value = model.note,
                onValueChange = onEditNoteChange,
                label = { Text(stringResource(R.string.share_note_label)) },
                enabled = !model.saving,
                minLines = 2,
                modifier = Modifier
                    .fillMaxWidth()
                    .testTag("edit_note"),
            )
            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Button(
                    onClick = onSaveEdit,
                    enabled = !model.saving,
                    modifier = Modifier.testTag("save_edit"),
                ) {
                    Text(stringResource(R.string.library_save_edit))
                }
                OutlinedButton(
                    onClick = onCancelEdit,
                    enabled = !model.saving,
                    modifier = Modifier.testTag("cancel_edit"),
                ) {
                    Text(stringResource(R.string.library_cancel_edit))
                }
                TextButton(
                    onClick = onDeleteEditing,
                    enabled = !model.saving,
                    modifier = Modifier.testTag("delete_editing"),
                ) {
                    Text(
                        text = stringResource(R.string.library_delete),
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            }
        }
    }
}

@Composable
private fun StatusCard(
    status: String,
    tag: String = "status",
) {
    if (status.isEmpty()) return
    Surface(
        shape = MaterialTheme.shapes.medium,
        color = MaterialTheme.colorScheme.secondaryContainer,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Text(
            text = status,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSecondaryContainer,
            modifier = Modifier
                .padding(14.dp)
                .testTag(tag),
        )
    }
}

@Composable
private fun ShareFooter(
    model: ShareScreenModel,
    onSave: () -> Unit,
    onClose: () -> Unit,
) {
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
                is AppUpdateState.Downloading -> stringResource(R.string.update_downloading_title, updateState.update.versionName)
                AppUpdateState.Failed -> stringResource(R.string.update_failed_title)
                AppUpdateState.Hidden -> ""
                is AppUpdateState.InstallFailed -> stringResource(R.string.update_install_failed_title)
                is AppUpdateState.InstallPermissionRequired -> stringResource(R.string.update_permission_title)
                is AppUpdateState.InstallStarted -> stringResource(R.string.update_install_started_title)
                AppUpdateState.UpToDate -> stringResource(R.string.update_latest_title)
            }
            val message = when (updateState) {
                is AppUpdateState.Available -> stringResource(
                    R.string.update_available_message,
                    currentVersionName,
                    updateState.update.versionName,
                )
                AppUpdateState.Checking -> stringResource(R.string.update_checking_message)
                is AppUpdateState.Downloading -> stringResource(R.string.update_downloading_message)
                AppUpdateState.Failed -> stringResource(R.string.update_failed_message)
                AppUpdateState.Hidden -> ""
                is AppUpdateState.InstallFailed -> stringResource(R.string.update_install_failed_message)
                is AppUpdateState.InstallPermissionRequired -> stringResource(R.string.update_permission_message)
                is AppUpdateState.InstallStarted -> stringResource(R.string.update_install_started_message, updateState.update.versionName)
                AppUpdateState.UpToDate -> stringResource(R.string.update_latest_message, currentVersionName)
            }

            Row(
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (updateState == AppUpdateState.Checking || updateState is AppUpdateState.Downloading) {
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
                    Text(stringResource(R.string.update_download_install))
                }
                is AppUpdateState.InstallFailed -> Button(
                    onClick = onOpenUpdate,
                    modifier = Modifier.testTag("download_update"),
                ) {
                    Text(stringResource(R.string.update_retry_install))
                }
                is AppUpdateState.InstallPermissionRequired -> Button(
                    onClick = onOpenUpdate,
                    modifier = Modifier.testTag("download_update"),
                ) {
                    Text(stringResource(R.string.update_open_permission_settings))
                }
                AppUpdateState.Failed,
                AppUpdateState.UpToDate -> OutlinedButton(
                    onClick = onCheckUpdate,
                    modifier = Modifier.testTag("check_update"),
                ) {
                    Text(stringResource(R.string.update_check_again))
                }
                AppUpdateState.Checking,
                is AppUpdateState.Downloading,
                AppUpdateState.Hidden -> Unit
                is AppUpdateState.InstallStarted -> OutlinedButton(
                    onClick = onCheckUpdate,
                    modifier = Modifier.testTag("check_update"),
                ) {
                    Text(stringResource(R.string.update_check_again))
                }
            }
        }
    }
}

@Composable
private fun Header(libraryMode: Boolean) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(
            text = if (libraryMode) {
                stringResource(R.string.library_header_title)
            } else {
                stringResource(R.string.share_title)
            },
            style = MaterialTheme.typography.headlineMedium,
            fontWeight = FontWeight.Bold,
        )
        Text(
            text = if (libraryMode) {
                stringResource(R.string.library_header_subtitle)
            } else {
                stringResource(R.string.share_subtitle)
            },
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

private fun SavedLink.displayTitle(): String =
    runCatching {
        val parsed = URL(url)
        UrlDisplayLabel.render(
            host = parsed.host,
            port = parsed.port,
            scheme = parsed.protocol,
            rawPath = parsed.path,
        )
    }.getOrDefault(url)

private fun String.shortDateTime(): String =
    if (length >= 16 && this[10] == 'T') {
        "${substring(0, 10)} ${substring(11, 16)}"
    } else {
        this
    }
