package com.alpenl.cairn.share.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.alpenl.cairn.share.ui.theme.CairnTheme
import com.alpenl.cairn.share.ui.theme.CairnTokens

/** Kind of tag, which decides its dot / tint (prototype .tag-ok / .tag-ai / .tag-auto). */
enum class TagTone { Topic, Resource, Feature, Personal }

/** Confirmation state of a tag on a bookmark. */
enum class TagState { Confirmed, Automatic, Suggested }

@Composable
fun tagColor(tone: TagTone): Color = with(CairnTheme.palette) {
    when (tone) { TagTone.Topic -> topicTag; TagTone.Resource -> resourceTag; TagTone.Feature -> featureTag; TagTone.Personal -> personalTag }
}

/**
 * A tag pill. Confirmed tags are filled olive, automatic ones are a quiet
 * outline, AI suggestions waiting for confirmation are dashed fig.
 */
@Composable
fun TagChip(
    label: String,
    modifier: Modifier = Modifier,
    tone: TagTone = TagTone.Topic,
    state: TagState = TagState.Confirmed,
    selected: Boolean = false,
    count: Int? = null,
    onClick: (() -> Unit)? = null,
) {
    val p = CairnTheme.palette
    val shape = RoundedCornerShape(CairnTokens.Radius.Pill)
    val bg = when {
        selected -> p.terracotta
        state == TagState.Confirmed -> p.olive.copy(alpha = .14f)
        state == TagState.Suggested -> p.fig.copy(alpha = .06f)
        else -> p.surface
    }
    val fg = when {
        selected -> p.onAccent
        state == TagState.Suggested -> p.fig
        state == TagState.Confirmed -> p.oliveInk
        else -> p.inkSoft
    }
    var m = modifier.clip(shape).background(bg, shape)
    if (!selected && state != TagState.Confirmed) m = m.border(1.dp, if (state == TagState.Suggested) p.fig.copy(alpha = .6f) else p.hairlineSoft, shape)
    if (onClick != null) m = m.clickable(role = Role.Button, onClick = onClick)
    Row(m.heightIn(min = 28.dp).padding(horizontal = 10.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        if (!selected) Box(Modifier.size(6.dp).clip(CircleShape).background(tagColor(tone)))
        Text(label, style = MaterialTheme.typography.labelMedium, color = fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (count != null) Text(count.toString(), style = MaterialTheme.typography.labelSmall, color = fg.copy(alpha = .7f))
    }
}

/** Two or three mutually exclusive options in a sand track (prototype .seg). */
@Composable
fun <T> SegmentedToggle(
    options: List<Pair<T, String>>,
    selected: T,
    onSelect: (T) -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    val p = CairnTheme.palette
    Row(
        modifier.clip(RoundedCornerShape(10.dp)).background(p.secondary).padding(3.dp).selectableGroup(),
        horizontalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        for ((value, label) in options) {
            val on = value == selected
            Box(
                Modifier.clip(RoundedCornerShape(8.dp))
                    .background(if (on) p.surface else Color.Transparent)
                    .then(if (on) Modifier.border(1.dp, p.hairlineSoft, RoundedCornerShape(8.dp)) else Modifier)
                    .selectable(selected = on, enabled = enabled, role = Role.RadioButton, onClick = { onSelect(value) })
                    .heightIn(min = 34.dp).padding(horizontal = 14.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(label, style = MaterialTheme.typography.labelLarge.copy(fontWeight = if (on) FontWeight.SemiBold else FontWeight.Medium),
                    color = if (on) p.ink else p.muted)
            }
        }
    }
}

/** Small numeric badge (待审核, 待上传). */
@Composable
fun CountBadge(count: Int, modifier: Modifier = Modifier, color: Color = CairnTheme.palette.terracotta) {
    if (count <= 0) return
    Box(modifier.heightIn(min = 18.dp).clip(RoundedCornerShape(9.dp)).background(color.copy(alpha = .14f)).padding(horizontal = 6.dp), contentAlignment = Alignment.Center) {
        Text(if (count > 99) "99+" else count.toString(), style = MaterialTheme.typography.labelSmall, color = color)
    }
}

/** A titled card of rows (prototype .set-group / .set-card). */
@Composable
fun SettingsGroup(title: String, modifier: Modifier = Modifier, note: String? = null, content: @Composable ColumnScope.() -> Unit) {
    val p = CairnTheme.palette
    Column(modifier.fillMaxWidth()) {
        Text(title, style = MaterialTheme.typography.labelLarge, color = p.ink, modifier = Modifier.padding(start = 4.dp, bottom = 2.dp))
        if (note != null) Text(note, style = MaterialTheme.typography.bodySmall, color = p.tertiary, modifier = Modifier.padding(start = 4.dp, bottom = 8.dp))
        else Spacer(Modifier.size(6.dp))
        Column(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(CairnTokens.Radius.Card)).background(p.surface)
                .border(1.dp, p.hairlineSoft, RoundedCornerShape(CairnTokens.Radius.Card)),
            content = content,
        )
    }
}

/** One row inside [SettingsGroup]; [trailing] holds a switch, value or chevron. */
@Composable
fun SettingsRow(
    title: String,
    modifier: Modifier = Modifier,
    description: String? = null,
    divider: Boolean = true,
    onClick: (() -> Unit)? = null,
    trailing: @Composable RowScope.() -> Unit = {},
) {
    val p = CairnTheme.palette
    Column(modifier) {
        Row(
            (if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier).fillMaxWidth().heightIn(min = 56.dp).padding(horizontal = 16.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text(title, style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.Medium), color = p.ink)
                if (description != null) Text(description, style = MaterialTheme.typography.bodySmall, color = p.tertiary)
            }
            Spacer(Modifier.width(12.dp))
            trailing()
        }
        if (divider) HorizontalDivider(Modifier.padding(start = 16.dp), color = p.hairlineSoft)
    }
}
