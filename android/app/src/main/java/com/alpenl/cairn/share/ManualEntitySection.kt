package com.alpenl.cairn.share

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.alpenl.cairn.share.network.MultidimensionalSelection
import com.alpenl.cairn.share.network.validEntityName

/** Name-level human curation. It never assigns a canonical identity or an AI status. */
@Composable
internal fun ManualEntitySection(
    linkId: Int,
    accountIdentity: String,
    selection: MultidimensionalSelection,
    busy: Boolean,
    onAction: (String, String, String) -> Unit,
) {
    val state = selection.state?.entities
    if (state == null) {
        Text("当前服务未提供实体整理状态，暂时只读。", Modifier.testTag("v2_entities_readonly"))
        return
    }
    key(linkId, accountIdentity) {
        var name by rememberSaveable { mutableStateOf("") }
        var confirmation by remember { mutableStateOf<Pair<String, String>?>(null) }
        val names = selection.entityNames.orEmpty()
        val pending = "entities" in selection.pendingFields
        val uncertain = "entities" in selection.unknownResetFields
        Column(Modifier.fillMaxWidth().testTag("v2_entity_management"), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("人工整理实体名称", style = MaterialTheme.typography.labelLarge)
            Text("同名的判断记录一并生效。人工填写名称不会自动取得身份依据。", style = MaterialTheme.typography.bodySmall)
            if (pending) Text(if (uncertain) "实体结果待服务端确认，暂不预览。" else "本地修改，待同步。",
                Modifier.testTag("v2_entities_pending"))
            if (!uncertain) {
                if (names.isEmpty()) Text(if (pending) "本地留空，待同步。" else
                    state.emptyOrigin?.let { "明确留空 · " + it.label } ?: "当前没有有效实体名称",
                    Modifier.testTag("v2_entities_empty"))
                names.forEachIndexed { index, term ->
                    Column(Modifier.testTag("v2_entity_name_row_" + index)) {
                        val origin = if (pending) "本地修改，待同步"
                            else state.values.firstOrNull { it.term == term }?.label ?: "来源未知"
                        Text(term + " · " + origin)
                        Row {
                            TextButton(onClick = { onAction("entities", term, "accept") },
                                enabled = !busy && validEntityName(term), modifier = Modifier.testTag("v2_entity_keep_" + index)) { Text("人工保留") }
                            TextButton(onClick = { confirmation = term to "reject" },
                                enabled = !busy && validEntityName(term), modifier = Modifier.testTag("v2_entity_remove_" + index)) { Text("移除名称") }
                            TextButton(onClick = { onAction("entities", term, "reset") },
                                enabled = !busy, modifier = Modifier.testTag("v2_entity_reset_" + index)) { Text("恢复自动") }
                        }
                    }
                }
                selection.state?.entityAutomatic.orEmpty().filterNot { it in names }.forEachIndexed { index, term ->
                    Row {
                        Text(term + " · 已移除", Modifier.weight(1f))
                        TextButton(onClick = { onAction("entities", term, "reset") }, enabled = !busy,
                            modifier = Modifier.testTag("v2_entity_restore_" + index)) { Text("恢复此名称") }
                    }
                }
            }
            OutlinedTextField(value = name, onValueChange = { name = it }, enabled = !busy,
                label = { Text("添加实体名称") }, singleLine = true,
                isError = name.length > 120, supportingText = { if (name.length > 120) Text("名称最多120个字符。") },
                modifier = Modifier.fillMaxWidth().testTag("v2_entity_name"))
            Row {
                TextButton(onClick = { val value = name.trim(); onAction("entities", value, "accept"); name = "" },
                    enabled = !busy && validEntityName(name.trim()), modifier = Modifier.testTag("v2_entity_add")) { Text("添加名称") }
                TextButton(onClick = { confirmation = "" to "set_empty" }, enabled = !busy,
                    modifier = Modifier.testTag("v2_entities_clear")) { Text("明确留空") }
                TextButton(onClick = { confirmation = "" to "reset" }, enabled = !busy,
                    modifier = Modifier.testTag("v2_entities_reset")) { Text("恢复全部自动") }
            }
        }
        confirmation?.let { (term, action) ->
            AlertDialog(onDismissRequest = { confirmation = null }, modifier = Modifier.testTag("v2_entities_confirm"),
                title = { Text(when (action) { "reject" -> "移除这个名称？"; "set_empty" -> "将实体名称明确留空？"; else -> "恢复自动实体名称？" }) },
                text = { Text(when (action) {
                    "reject" -> "同名的所有实体判断将不再作为有效结果，原始依据仍会保留。"
                    "set_empty" -> "将不保留任何实体名称，直到你明确恢复或添加。原始判断和依据不会删除。"
                    else -> "取消对应的人工覆盖，恢复当前来源的自动名称。尚未运行、失败和过期状态会继续如实显示。"
                }) },
                confirmButton = { TextButton(onClick = {
                    confirmation = null
                    onAction("entities", term, action)
                }, enabled = !busy, modifier = Modifier.testTag("v2_entities_confirm_apply")) { Text("确认") } },
                dismissButton = { TextButton(onClick = { confirmation = null }) { Text("取消") } })
        }
    }
}
