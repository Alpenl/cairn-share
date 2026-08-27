package com.alpenl.cairn.share.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

private val LightColors = lightColorScheme(
    primary = Color(0xFF145C52),
    onPrimary = Color.White,
    primaryContainer = Color(0xFFCDE2DB),
    onPrimaryContainer = Color(0xFF05231E),
    secondary = Color(0xFF4B544F),
    onSecondary = Color.White,
    secondaryContainer = Color(0xFFE8EBE6),
    onSecondaryContainer = Color(0xFF151A18),
    tertiary = Color(0xFF7C4A12),
    onTertiary = Color.White,
    tertiaryContainer = Color(0xFFEFDCC3),
    onTertiaryContainer = Color(0xFF2C1A05),
    error = Color(0xFF8F2B22),
    errorContainer = Color(0xFFF1DAD6),
    surface = Color(0xFFF8F9F7),
    surfaceVariant = Color(0xFFEFF1ED),
    onSurface = Color(0xFF151A18),
    onSurfaceVariant = Color(0xFF4B544F),
    background = Color(0xFFEAEBE6),
    outline = Color(0xFF7B857F),
    outlineVariant = Color(0xFFD3D9D3),
)

private val DarkColors = darkColorScheme(
    primary = Color(0xFF83CBB9),
    onPrimary = Color(0xFF00332C),
    primaryContainer = Color(0xFF1D4A42),
    onPrimaryContainer = Color(0xFFB4E3D6),
    secondary = Color(0xFFB2BCB7),
    onSecondary = Color(0xFF1D2321),
    secondaryContainer = Color(0xFF252C29),
    onSecondaryContainer = Color(0xFFE2E6E3),
    tertiary = Color(0xFFDFB483),
    onTertiary = Color(0xFF2C1A05),
    tertiaryContainer = Color(0xFF42311B),
    onTertiaryContainer = Color(0xFFF3DCBE),
    error = Color(0xFFF0A69C),
    errorContainer = Color(0xFF4A1B15),
    surface = Color(0xFF0F1312),
    surfaceVariant = Color(0xFF1D2321),
    onSurface = Color(0xFFE2E6E3),
    onSurfaceVariant = Color(0xFFB2BCB7),
    background = Color(0xFF0A0D0C),
    outline = Color(0xFF7C8781),
    outlineVariant = Color(0xFF39413D),
)

private val AppShapes = Shapes(
    extraSmall = RoundedCornerShape(8.dp),
    small = RoundedCornerShape(10.dp),
    medium = RoundedCornerShape(16.dp),
    large = RoundedCornerShape(20.dp),
    extraLarge = RoundedCornerShape(26.dp),
)

@Composable
internal fun CairnShareTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = if (isSystemInDarkTheme()) DarkColors else LightColors,
        shapes = AppShapes,
        content = content,
    )
}
