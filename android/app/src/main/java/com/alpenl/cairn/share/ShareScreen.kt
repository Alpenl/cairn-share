package com.alpenl.cairn.share

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.alpenl.cairn.share.contract.UrlDisplayLabel
import com.alpenl.cairn.share.network.LinkFilter
import com.alpenl.cairn.share.network.SavedLink
import java.net.URL

private val AvatarPalette = listOf(
    AvatarTone(Color(0xFFE1E8D8), Color(0xFF344C19)),
    AvatarTone(Color(0xFFD8E7EA), Color(0xFF174A53)),
    AvatarTone(Color(0xFFE8DEEF), Color(0xFF4C315D)),
    AvatarTone(Color(0xFFF0E1D3), Color(0xFF65411D)),
    AvatarTone(Color(0xFFDDE5F4), Color(0xFF29476C)),
)

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
                .padding(horizontal = 16.dp, vertical = 14.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
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
                    shape = RoundedCornerShape(25.dp),
                    border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
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
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        tonalElevation = 0.dp,
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
                    style = MaterialTheme.typography.labelLarge,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                LazyColumn(
                    modifier = Modifier
                        .fillMaxWidth()
                        .weight(1f, fill = false)
                        .sizeIn(maxHeight = 280.dp),
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
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
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
                    shape = RoundedCornerShape(18.dp),
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
    Column(
        modifier = modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        LibraryToolbar(
            model = model,
            onRefreshLinks = onRefreshLinks,
        )
        LibrarySummary(model)
        SearchRow(
            model = model,
            onSearchQueryChange = onSearchQueryChange,
            onSearch = onSearch,
        )
        FilterRow(
            selected = model.filter,
            onFilterChange = onFilterChange,
            enabled = !model.loading,
        )
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
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            if (model.items.isEmpty() && !model.loading) {
                item {
                    EmptyLibraryState(
                        message = model.statusText.ifBlank {
                            stringResource(R.string.library_empty_all)
                        },
                    )
                }
            }
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

@Composable
private fun LibraryToolbar(
    model: LinkLibraryModel,
    onRefreshLinks: () -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(3.dp),
        ) {
            Text(
                text = stringResource(R.string.library_title),
                style = MaterialTheme.typography.headlineSmall,
                fontWeight = FontWeight.SemiBold,
            )
            Text(
                text = stringResource(R.string.library_hint),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
        OutlinedButton(
            onClick = onRefreshLinks,
            enabled = !model.loading,
            shape = RoundedCornerShape(20.dp),
            border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
            contentPadding = PaddingValues(horizontal = 14.dp, vertical = 8.dp),
            modifier = Modifier.testTag("refresh_links"),
        ) {
            Text(stringResource(R.string.library_refresh), maxLines = 1)
        }
    }
}

@Composable
private fun LibrarySummary(model: LinkLibraryModel) {
    val total = model.items.size
    val learned = model.items.count { it.learned }
    val pending = total - learned
    val progress = if (total == 0) 0f else learned.toFloat() / total.toFloat()
    val summary = when (model.filter) {
        LinkFilter.All -> if (total == 0) {
            stringResource(R.string.library_empty_all)
        } else {
            "$total 条收藏 · $pending 条待读"
        }
        LinkFilter.Unlearned -> if (total == 0) {
            stringResource(R.string.library_empty_unlearned)
        } else {
            "$total 条排在待学习里"
        }
        LinkFilter.Learned -> if (total == 0) {
            stringResource(R.string.library_empty_learned)
        } else {
            "$total 条已经读完"
        }
    }

    Surface(
        shape = MaterialTheme.shapes.large,
        color = MaterialTheme.colorScheme.surfaceVariant,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 14.dp),
            horizontalArrangement = Arrangement.spacedBy(16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            ProgressRing(progress = progress)
            Column(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(3.dp),
            ) {
                Text(
                    text = if (model.loading) "正在同步云端链接" else summary,
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                )
                Text(
                    text = if (model.searchQuery.isBlank()) {
                        "搜索、筛选、编辑与学习状态都在这一屏完成。"
                    } else {
                        "正在按「${model.searchQuery}」查看匹配结果。"
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

@Composable
private fun ProgressRing(progress: Float) {
    Box(
        modifier = Modifier.size(52.dp),
        contentAlignment = Alignment.Center,
    ) {
        val trackColor = MaterialTheme.colorScheme.outlineVariant
        val valueColor = MaterialTheme.colorScheme.primary
        Canvas(modifier = Modifier.fillMaxSize()) {
            val strokeWidth = 5.dp.toPx()
            val diameter = size.minDimension - strokeWidth
            val topLeft = Offset(
                x = (size.width - diameter) / 2f,
                y = (size.height - diameter) / 2f,
            )
            val arcSize = Size(diameter, diameter)
            drawCircle(
                color = trackColor,
                radius = diameter / 2f,
                style = Stroke(width = strokeWidth, cap = StrokeCap.Round),
            )
            drawArc(
                color = valueColor,
                startAngle = -90f,
                sweepAngle = 360f * progress.coerceIn(0f, 1f),
                useCenter = false,
                topLeft = topLeft,
                size = arcSize,
                style = Stroke(width = strokeWidth, cap = StrokeCap.Round),
            )
        }
        Text(
            text = "${(progress.coerceIn(0f, 1f) * 100).toInt()}%",
            style = MaterialTheme.typography.labelMedium,
            fontWeight = FontWeight.SemiBold,
            fontFamily = FontFamily.Monospace,
        )
    }
}

@Composable
private fun SearchRow(
    model: LinkLibraryModel,
    onSearchQueryChange: (String) -> Unit,
    onSearch: () -> Unit,
) {
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
            enabled = !model.loading,
            shape = RoundedCornerShape(26.dp),
            modifier = Modifier
                .weight(1f)
                .testTag("library_search"),
        )
        Button(
            onClick = onSearch,
            enabled = !model.loading,
            shape = RoundedCornerShape(25.dp),
            contentPadding = PaddingValues(horizontal = 18.dp),
            modifier = Modifier
                .height(50.dp)
                .testTag("library_search_button"),
        ) {
            Text(stringResource(R.string.library_search), maxLines = 1)
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
        Button(
            onClick = onClick,
            enabled = enabled,
            shape = RoundedCornerShape(10.dp),
            contentPadding = PaddingValues(horizontal = 10.dp),
            colors = ButtonDefaults.buttonColors(
                containerColor = MaterialTheme.colorScheme.primaryContainer,
                contentColor = MaterialTheme.colorScheme.onPrimaryContainer,
            ),
            modifier = modifier.height(38.dp),
        ) {
            Text(label, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    } else {
        OutlinedButton(
            onClick = onClick,
            enabled = enabled,
            shape = RoundedCornerShape(10.dp),
            contentPadding = PaddingValues(horizontal = 10.dp),
            border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
            colors = ButtonDefaults.outlinedButtonColors(
                contentColor = MaterialTheme.colorScheme.onSurfaceVariant,
            ),
            modifier = modifier.height(38.dp),
        ) {
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
    val createdAt = stringResource(R.string.library_created_at, link.createdAt.shortDateTime())

    Surface(
        shape = MaterialTheme.shapes.large,
        color = MaterialTheme.colorScheme.surface,
        border = BorderStroke(
            width = 1.dp,
            color = if (link.learned) {
                MaterialTheme.colorScheme.outlineVariant
            } else {
                MaterialTheme.colorScheme.primaryContainer
            },
        ),
        modifier = Modifier
            .fillMaxWidth()
            .testTag("link_${link.id}"),
    ) {
        Column(
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(9.dp),
        ) {
            Row(
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalAlignment = Alignment.Top,
            ) {
                HostAvatar(url = link.url)
                Column(
                    modifier = Modifier.weight(1f),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Row(
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalAlignment = Alignment.Top,
                    ) {
                        Text(
                            text = link.displayTitle(),
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                            style = MaterialTheme.typography.titleSmall,
                            fontWeight = FontWeight.SemiBold,
                            modifier = Modifier.weight(1f),
                        )
                        StatePill(learned = link.learned)
                    }
                    Text(
                        text = "${link.hostLabel()} · $createdAt",
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        fontFamily = FontFamily.Monospace,
                    )
                    Text(
                        text = link.url,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        fontFamily = FontFamily.Monospace,
                    )
                }
            }

            if (link.note.isNotBlank()) {
                Text(
                    text = link.note,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurface,
                )
            }

            Row(
                horizontalArrangement = Arrangement.spacedBy(2.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                TextButton(
                    onClick = onOpenLink,
                    contentPadding = PaddingValues(horizontal = 10.dp, vertical = 4.dp),
                    modifier = Modifier.testTag("open_${link.id}"),
                ) {
                    Text(stringResource(R.string.library_open))
                }
                TextButton(
                    onClick = onToggleLearned,
                    contentPadding = PaddingValues(horizontal = 10.dp, vertical = 4.dp),
                    modifier = Modifier.testTag("toggle_${link.id}"),
                ) {
                    Text(
                        if (link.learned) {
                            stringResource(R.string.library_mark_unlearned)
                        } else {
                            stringResource(R.string.library_mark_learned)
                        },
                    )
                }
                TextButton(
                    onClick = onEditLink,
                    contentPadding = PaddingValues(horizontal = 10.dp, vertical = 4.dp),
                    modifier = Modifier.testTag("edit_${link.id}"),
                ) {
                    Text(stringResource(R.string.library_edit))
                }
            }
        }
    }
}

@Composable
private fun HostAvatar(url: String) {
    val host = url.hostLabel()
    val tone = avatarTone(host)
    Surface(
        shape = RoundedCornerShape(14.dp),
        color = tone.container,
        contentColor = tone.content,
        modifier = Modifier.size(42.dp),
    ) {
        Box(contentAlignment = Alignment.Center) {
            Text(
                text = host.firstOrNull()?.uppercaseChar()?.toString() ?: "?",
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
                fontFamily = FontFamily.Monospace,
            )
        }
    }
}

@Composable
private fun StatePill(learned: Boolean) {
    val container = if (learned) {
        MaterialTheme.colorScheme.primaryContainer
    } else {
        MaterialTheme.colorScheme.tertiaryContainer
    }
    val content = if (learned) {
        MaterialTheme.colorScheme.onPrimaryContainer
    } else {
        MaterialTheme.colorScheme.onTertiaryContainer
    }
    Surface(
        shape = RoundedCornerShape(8.dp),
        color = container,
        contentColor = content,
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 5.dp),
            horizontalArrangement = Arrangement.spacedBy(5.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                modifier = Modifier
                    .size(6.dp)
                    .background(content, CircleShape),
            )
            Text(
                text = if (learned) {
                    stringResource(R.string.library_state_learned)
                } else {
                    stringResource(R.string.library_state_unlearned)
                },
                style = MaterialTheme.typography.labelSmall,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
            )
        }
    }
}

@Composable
private fun EmptyLibraryState(message: String) {
    Surface(
        shape = MaterialTheme.shapes.large,
        color = MaterialTheme.colorScheme.surfaceVariant,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(
            modifier = Modifier.padding(horizontal = 28.dp, vertical = 38.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Surface(
                shape = RoundedCornerShape(20.dp),
                color = MaterialTheme.colorScheme.surface,
                modifier = Modifier.size(56.dp),
            ) {
                Box(contentAlignment = Alignment.Center) {
                    Text(
                        text = "0",
                        style = MaterialTheme.typography.titleMedium,
                        fontFamily = FontFamily.Monospace,
                        color = MaterialTheme.colorScheme.outline,
                    )
                }
            }
            Text(
                text = message,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 3,
                overflow = TextOverflow.Ellipsis,
            )
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
        shape = MaterialTheme.shapes.extraLarge,
        color = MaterialTheme.colorScheme.surfaceVariant,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        modifier = Modifier
            .fillMaxWidth()
            .testTag("edit_panel"),
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                text = stringResource(R.string.library_edit_title, model.link.id),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
            )
            OutlinedTextField(
                value = model.url,
                onValueChange = onEditUrlChange,
                label = { Text(stringResource(R.string.library_url_label)) },
                enabled = !model.saving,
                singleLine = true,
                shape = RoundedCornerShape(16.dp),
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
                shape = RoundedCornerShape(16.dp),
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
                    shape = RoundedCornerShape(20.dp),
                    modifier = Modifier.testTag("save_edit"),
                ) {
                    Text(stringResource(R.string.library_save_edit))
                }
                OutlinedButton(
                    onClick = onCancelEdit,
                    enabled = !model.saving,
                    shape = RoundedCornerShape(20.dp),
                    border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
                    modifier = Modifier.testTag("cancel_edit"),
                ) {
                    Text(stringResource(R.string.library_cancel_edit))
                }
                TextButton(
                    onClick = onDeleteEditing,
                    enabled = !model.saving,
                    colors = ButtonDefaults.textButtonColors(
                        contentColor = MaterialTheme.colorScheme.error,
                    ),
                    modifier = Modifier.testTag("delete_editing"),
                ) {
                    Text(stringResource(R.string.library_delete))
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
        shape = RoundedCornerShape(14.dp),
        color = MaterialTheme.colorScheme.secondaryContainer,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Text(
            text = status,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSecondaryContainer,
            modifier = Modifier
                .padding(horizontal = 14.dp, vertical = 12.dp)
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
            shape = RoundedCornerShape(25.dp),
            border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
            modifier = Modifier.weight(1f),
        ) {
            Text(stringResource(R.string.share_cancel))
        }
        if (model.selectedLabel != null || model.submitting) {
            Button(
                onClick = onSave,
                enabled = model.saveEnabled,
                shape = RoundedCornerShape(25.dp),
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
    val shape = MaterialTheme.shapes.extraLarge

    Box(
        modifier = Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(
                Brush.linearGradient(
                    listOf(
                        MaterialTheme.colorScheme.primaryContainer,
                        MaterialTheme.colorScheme.surfaceVariant,
                    ),
                ),
            )
            .border(1.dp, MaterialTheme.colorScheme.outlineVariant, shape)
            .testTag("update_card"),
    ) {
        Column(
            modifier = Modifier.padding(18.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                text = "GITHUB RELEASE",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onPrimaryContainer,
                fontFamily = FontFamily.Monospace,
                fontWeight = FontWeight.SemiBold,
            )
            Row(
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (updateState == AppUpdateState.Checking || updateState is AppUpdateState.Downloading) {
                    CircularProgressIndicator(
                        strokeWidth = 2.dp,
                        color = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.sizeIn(maxWidth = 18.dp, maxHeight = 18.dp),
                    )
                }
                Text(
                    text = title,
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                    color = MaterialTheme.colorScheme.onPrimaryContainer,
                    modifier = Modifier.testTag("update_title"),
                )
            }
            Text(
                text = message,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.testTag("update_message"),
            )
            if (updateState == AppUpdateState.Checking || updateState is AppUpdateState.Downloading) {
                LinearProgressIndicator(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(6.dp)
                        .clip(RoundedCornerShape(3.dp)),
                    color = MaterialTheme.colorScheme.primary,
                    trackColor = MaterialTheme.colorScheme.onPrimaryContainer.copy(alpha = 0.12f),
                )
            }
            when (updateState) {
                is AppUpdateState.Available -> Button(
                    onClick = onOpenUpdate,
                    shape = RoundedCornerShape(25.dp),
                    modifier = Modifier.testTag("download_update"),
                ) {
                    Text(stringResource(R.string.update_download_install))
                }
                is AppUpdateState.InstallFailed -> Button(
                    onClick = onOpenUpdate,
                    shape = RoundedCornerShape(25.dp),
                    modifier = Modifier.testTag("download_update"),
                ) {
                    Text(stringResource(R.string.update_retry_install))
                }
                is AppUpdateState.InstallPermissionRequired -> Button(
                    onClick = onOpenUpdate,
                    shape = RoundedCornerShape(25.dp),
                    modifier = Modifier.testTag("download_update"),
                ) {
                    Text(stringResource(R.string.update_open_permission_settings))
                }
                AppUpdateState.Failed,
                AppUpdateState.UpToDate -> OutlinedButton(
                    onClick = onCheckUpdate,
                    shape = RoundedCornerShape(25.dp),
                    border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline),
                    modifier = Modifier.testTag("check_update"),
                ) {
                    Text(stringResource(R.string.update_check_again))
                }
                AppUpdateState.Checking,
                is AppUpdateState.Downloading,
                AppUpdateState.Hidden -> Unit
                is AppUpdateState.InstallStarted -> OutlinedButton(
                    onClick = onCheckUpdate,
                    shape = RoundedCornerShape(25.dp),
                    border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline),
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
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(
            horizontalArrangement = Arrangement.spacedBy(9.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                modifier = Modifier
                    .width(26.dp)
                    .height(1.dp)
                    .background(MaterialTheme.colorScheme.primary),
            )
            Text(
                text = "CAIRN SHARE",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                fontFamily = FontFamily.Monospace,
                fontWeight = FontWeight.SemiBold,
            )
        }
        Text(
            text = if (libraryMode) {
                stringResource(R.string.library_header_title)
            } else {
                stringResource(R.string.share_title)
            },
            style = MaterialTheme.typography.headlineLarge,
            fontWeight = FontWeight.SemiBold,
        )
        Text(
            text = if (libraryMode) {
                stringResource(R.string.library_header_subtitle)
            } else {
                stringResource(R.string.share_subtitle)
            },
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
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
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        modifier = modifier
            .fillMaxWidth()
            .clickable(role = Role.Button, onClick = onClick),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.Top,
        ) {
            Box(
                modifier = Modifier
                    .padding(top = 2.dp)
                    .size(18.dp)
                    .border(1.dp, MaterialTheme.colorScheme.outline, CircleShape),
            )
            Text(
                text = label,
                maxLines = labelMaxLines,
                overflow = TextOverflow.Ellipsis,
                style = MaterialTheme.typography.bodyLarge,
                modifier = Modifier.weight(1f),
            )
        }
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
            verticalArrangement = Arrangement.spacedBy(5.dp),
        ) {
            Text(
                text = stringResource(R.string.share_selected_link),
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.onPrimaryContainer,
                fontWeight = FontWeight.SemiBold,
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

private data class AvatarTone(
    val container: Color,
    val content: Color,
)

private fun avatarTone(host: String): AvatarTone {
    val hash = host.fold(0) { acc, char -> (acc * 31 + char.code) and Int.MAX_VALUE }
    return AvatarPalette[hash % AvatarPalette.size]
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

private fun SavedLink.hostLabel(): String = url.hostLabel()

private fun String.hostLabel(): String =
    runCatching {
        URL(this).host.removePrefix("www.").ifBlank { this }
    }.getOrDefault(this)

private fun String.shortDateTime(): String =
    if (length >= 16 && this[10] == 'T') {
        "${substring(0, 10)} ${substring(11, 16)}"
    } else {
        this
    }
