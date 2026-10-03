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
    primary = Color(0xFF416A7A),
    onPrimary = Color.White,
    primaryContainer = Color(0xFFEEF4F6),
    onPrimaryContainer = Color(0xFF335564),
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
    surfaceVariant = Color(0xFFF5F7F8),
    surfaceContainer = Color(0xFFF8FAFA),
    surfaceContainerHigh = Color(0xFFF2F5F6),
    surfaceContainerHighest = Color(0xFFEDF1F3),
    onSurface = Color(0xFF293237),
    onSurfaceVariant = Color(0xFF68747B),
    background = Color.White,
    onBackground = Color(0xFF293237),
    outline = Color(0xFF87949B),
    outlineVariant = Color(0xFFEBEFF1),
)

private val DarkColors = darkColorScheme(
    primary = Color(0xFFA9C7D3),
    onPrimary = Color(0xFF193A48),
    primaryContainer = Color(0xFF253840),
    onPrimaryContainer = Color(0xFFC4DEE7),
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
    surface = Color(0xFF171C1F),
    surfaceVariant = Color(0xFF20292E),
    surfaceContainer = Color(0xFF1B2226),
    surfaceContainerHigh = Color(0xFF242D32),
    surfaceContainerHighest = Color(0xFF2C373D),
    onSurface = Color(0xFFE0E7EB),
    onSurfaceVariant = Color(0xFFA6B2BA),
    background = Color(0xFF171C1F),
    onBackground = Color(0xFFE0E7EB),
    outline = Color(0xFF818A9E),
    outlineVariant = Color(0xFF2B3439),
)

private val AppShapes = Shapes(
    extraSmall = RoundedCornerShape(4.dp),
    small = RoundedCornerShape(8.dp),
    medium = RoundedCornerShape(10.dp),
    large = RoundedCornerShape(12.dp),
    extraLarge = RoundedCornerShape(20.dp),
)

private val AppTypography = Typography(
    headlineLarge = TextStyle(fontSize = 24.sp, lineHeight = 34.sp, fontWeight = FontWeight.Medium),
    headlineSmall = TextStyle(fontSize = 23.sp, lineHeight = 34.sp, fontWeight = FontWeight.Medium),
    titleLarge = TextStyle(fontSize = 20.sp, lineHeight = 28.sp, fontWeight = FontWeight.Medium),
    titleMedium = TextStyle(fontSize = 16.sp, lineHeight = 25.sp, fontWeight = FontWeight.Medium),
    titleSmall = TextStyle(fontSize = 15.sp, lineHeight = 23.sp, fontWeight = FontWeight.Medium),
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
