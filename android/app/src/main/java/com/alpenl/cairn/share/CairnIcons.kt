package com.alpenl.cairn.share

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathBuilder
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.unit.dp

/** Small, consistent line icons, without adding a full icon-font dependency. */
internal object CairnIcons {
    private fun icon(name: String, draw: PathBuilder.() -> Unit) = ImageVector.Builder(
        name = name, defaultWidth = 24.dp, defaultHeight = 24.dp, viewportWidth = 24f, viewportHeight = 24f,
    ).apply {
        path(stroke = SolidColor(Color.Black), strokeLineWidth = 1.55f,
            strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round, pathBuilder = draw)
    }.build()

    val Library = icon("Library") {
        moveTo(5f, 3f); lineTo(19f, 3f); lineTo(19f, 21f); lineTo(12f, 17f); lineTo(5f, 21f); close()
        moveTo(9f, 7f); lineTo(15f, 7f)
    }
    val Reading = icon("Reading") {
        moveTo(12f, 5f); curveTo(8f, 2f, 4f, 3f, 2f, 4f); lineTo(2f, 19f)
        curveTo(5f, 18f, 9f, 18f, 12f, 21f); curveTo(15f, 18f, 19f, 18f, 22f, 19f)
        lineTo(22f, 4f); curveTo(19f, 3f, 15f, 2f, 12f, 5f); lineTo(12f, 21f)
    }
    val External = icon("External") {
        moveTo(14f, 3f); lineTo(21f, 3f); lineTo(21f, 10f)
        moveTo(21f, 3f); lineTo(10f, 14f)
        moveTo(10f, 5f); lineTo(5f, 5f); curveTo(4f, 5f, 3f, 6f, 3f, 7f)
        lineTo(3f, 19f); curveTo(3f, 20f, 4f, 21f, 5f, 21f); lineTo(17f, 21f)
        curveTo(18f, 21f, 19f, 20f, 19f, 19f); lineTo(19f, 14f)
    }
    val More = icon("More") {
        moveTo(5f, 11.5f); lineTo(5f, 12.5f)
        moveTo(12f, 11.5f); lineTo(12f, 12.5f)
        moveTo(19f, 11.5f); lineTo(19f, 12.5f)
    }
    val Chevron = icon("Chevron") { moveTo(9f, 5f); lineTo(16f, 12f); lineTo(9f, 19f) }
    val Down = icon("Down") { moveTo(6f, 9f); lineTo(12f, 15f); lineTo(18f, 9f) }
    val Filter = icon("Filter") {
        moveTo(3f, 6f); lineTo(21f, 6f); moveTo(6f, 12f); lineTo(18f, 12f)
        moveTo(9f, 18f); lineTo(15f, 18f)
    }
    val Offline = icon("Offline") {
        moveTo(12f, 3f); lineTo(12f, 15f); moveTo(7f, 10f); lineTo(12f, 15f); lineTo(17f, 10f)
        moveTo(4f, 16f); lineTo(4f, 21f); lineTo(20f, 21f); lineTo(20f, 16f)
    }
    val Settings = icon("Settings") {
        moveTo(3f, 6f); lineTo(7f, 6f); moveTo(11f, 6f); lineTo(21f, 6f)
        moveTo(7f, 6f); curveTo(7f, 3.3f, 11f, 3.3f, 11f, 6f); curveTo(11f, 8.7f, 7f, 8.7f, 7f, 6f)
        moveTo(3f, 12f); lineTo(14f, 12f); moveTo(18f, 12f); lineTo(21f, 12f)
        moveTo(14f, 12f); curveTo(14f, 9.3f, 18f, 9.3f, 18f, 12f); curveTo(18f, 14.7f, 14f, 14.7f, 14f, 12f)
        moveTo(3f, 18f); lineTo(7f, 18f); moveTo(11f, 18f); lineTo(21f, 18f)
        moveTo(7f, 18f); curveTo(7f, 15.3f, 11f, 15.3f, 11f, 18f); curveTo(11f, 20.7f, 7f, 20.7f, 7f, 18f)
    }
}
