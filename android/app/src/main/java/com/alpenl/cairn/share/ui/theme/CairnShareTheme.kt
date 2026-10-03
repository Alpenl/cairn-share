package com.alpenl.cairn.share.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight

private val LightColors = lightColorScheme(
    primary = Color(0xFF515CC5),
    onPrimary = Color.White,
    primaryContainer = Color(0xFFEEF0FF),
    onPrimaryContainer = Color(0xFF343F9A),
    secondary = Color(0xFF626A7B),
    onSecondary = Color.White,
    secondaryContainer = Color(0xFFF0F2F6),
    onSecondaryContainer = Color(0xFF444C5D),
    tertiary = Color(0xFF7C4A12),
    onTertiary = Color.White,
    tertiaryContainer = Color(0xFFEFDCC3),
    onTertiaryContainer = Color(0xFF2C1A05),
    error = Color(0xFF8F2B22),
    errorContainer = Color(0xFFF1DAD6),
    surface = Color.White,
    surfaceVariant = Color(0xFFF3F4F8),
    surfaceContainer = Color(0xFFF5F6FA),
    surfaceContainerHigh = Color(0xFFF0F2F6),
    surfaceContainerHighest = Color(0xFFECEEF4),
    onSurface = Color(0xFF202531),
    onSurfaceVariant = Color(0xFF646C7C),
    background = Color(0xFFFAFBFD),
    onBackground = Color(0xFF202531),
    outline = Color(0xFF858C9A),
    outlineVariant = Color(0xFFE6E8EF),
)

private val DarkColors = darkColorScheme(
    primary = Color(0xFFBCC2FF),
    onPrimary = Color(0xFF20276C),
    primaryContainer = Color(0xFF2C3258),
    onPrimaryContainer = Color(0xFFDCE0FF),
    secondary = Color(0xFFBCC2D0),
    onSecondary = Color(0xFF252B36),
    secondaryContainer = Color(0xFF262C38),
    onSecondaryContainer = Color(0xFFD5DAE6),
    tertiary = Color(0xFFDFB483),
    onTertiary = Color(0xFF2C1A05),
    tertiaryContainer = Color(0xFF42311B),
    onTertiaryContainer = Color(0xFFF3DCBE),
    error = Color(0xFFF0A69C),
    errorContainer = Color(0xFF4A1B15),
    surface = Color(0xFF191C24),
    surfaceVariant = Color(0xFF242833),
    surfaceContainer = Color(0xFF1E222C),
    surfaceContainerHigh = Color(0xFF262B36),
    surfaceContainerHighest = Color(0xFF303642),
    onSurface = Color(0xFFE8EBF3),
    onSurfaceVariant = Color(0xFFAFB6C6),
    background = Color(0xFF12151C),
    onBackground = Color(0xFFE8EBF3),
    outline = Color(0xFF818A9E),
    outlineVariant = Color(0xFF323846),
)

private val AppShapes = Shapes(
    extraSmall = RoundedCornerShape(8.dp),
    small = RoundedCornerShape(12.dp),
    medium = RoundedCornerShape(16.dp),
    large = RoundedCornerShape(16.dp),
    extraLarge = RoundedCornerShape(24.dp),
)

private val AppTypography = Typography(
    headlineLarge = TextStyle(fontSize = 30.sp, lineHeight = 40.sp, fontWeight = FontWeight.Bold),
    headlineSmall = TextStyle(fontSize = 24.sp, lineHeight = 34.sp, fontWeight = FontWeight.SemiBold),
    titleLarge = TextStyle(fontSize = 22.sp, lineHeight = 30.sp, fontWeight = FontWeight.SemiBold),
    titleMedium = TextStyle(fontSize = 17.sp, lineHeight = 26.sp, fontWeight = FontWeight.Medium),
    titleSmall = TextStyle(fontSize = 16.sp, lineHeight = 24.sp, fontWeight = FontWeight.Medium),
    bodyLarge = TextStyle(fontSize = 17.sp, lineHeight = 29.sp),
    bodyMedium = TextStyle(fontSize = 15.sp, lineHeight = 24.sp),
    bodySmall = TextStyle(fontSize = 13.sp, lineHeight = 21.sp),
    labelLarge = TextStyle(fontSize = 14.sp, lineHeight = 20.sp, fontWeight = FontWeight.Medium),
    labelMedium = TextStyle(fontSize = 12.sp, lineHeight = 18.sp, fontWeight = FontWeight.Medium),
    labelSmall = TextStyle(fontSize = 12.sp, lineHeight = 18.sp),
)

@Composable
internal fun CairnShareTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = if (isSystemInDarkTheme()) DarkColors else LightColors,
        shapes = AppShapes,
        typography = AppTypography,
        content = content,
    )
}
