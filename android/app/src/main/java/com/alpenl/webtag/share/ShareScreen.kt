package com.alpenl.webtag.share

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.sizeIn
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

@Composable
internal fun ShareScreen(
    model: ShareScreenModel,
    onSelectRow: (Int) -> Unit,
    onNoteChange: (String) -> Unit,
    onSave: () -> Unit,
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
                .padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text(
                text = stringResource(R.string.share_title),
                style = MaterialTheme.typography.headlineSmall,
            )

            if (model.rowLabels.isNotEmpty()) {
                Text(
                    text = stringResource(R.string.share_choose_link),
                    style = MaterialTheme.typography.titleMedium,
                )
                LazyColumn(
                    modifier = Modifier
                        .fillMaxWidth()
                        .weight(1f, fill = false)
                        .sizeIn(maxHeight = 260.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    itemsIndexed(model.rowLabels) { index, label ->
                        Surface(
                            shape = MaterialTheme.shapes.small,
                            tonalElevation = 1.dp,
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable(role = Role.Button) { onSelectRow(index) }
                                .testTag("candidate_$index"),
                        ) {
                            Text(
                                text = label,
                                maxLines = model.labelMaxLines,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.padding(12.dp),
                            )
                        }
                    }
                }
                HorizontalDivider()
            }

            model.selectedLabel?.let { label ->
                Text(
                    text = label,
                    maxLines = model.labelMaxLines,
                    overflow = TextOverflow.Ellipsis,
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.testTag("selected_label"),
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
                Text(
                    text = model.statusText,
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.testTag("status"),
                )
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
