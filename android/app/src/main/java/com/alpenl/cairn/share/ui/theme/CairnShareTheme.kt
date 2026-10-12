package com.alpenl.cairn.share.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp

// 2026-10 redesign: Claude palette (parchment canvas, sand chrome, terracotta
// CTAs; fig / olive / cactus / sky as tag and state accents). Material roles
// are mapped from the shared tokens so existing M3 components pick them up;
// accents Material has no role for live in [CairnPalette].

/** Accent colours with no Material 3 role. Read via [CairnTheme.palette]. */
@Immutable
data class CairnPalette(
    val canvas: Color,
    val surface: Color,
    val secondary: Color,
    val sand: Color,
    val sandHover: Color,
    val warm: Color,
    val manilla: Color,
    val kraft: Color,
    val ink: Color,
    val inkSoft: Color,
    val muted: Color,
    val tertiary: Color,
    val faint: Color,
    val hairline: Color,
    val hairlineSoft: Color,
    val terracotta: Color,
    val terracottaDeep: Color,
    val clay: Color,
    val fig: Color,
    val olive: Color,
    val oliveInk: Color,
    val cactus: Color,
    val sky: Color,
    val danger: Color,
    val onAccent: Color,
    val isDark: Boolean,
) {
    /** Tag-type dot colours: 主题 terracotta, 资源类型 sky, 内容特征 olive, 个人 kraft. */
    val topicTag get() = terracotta
    val resourceTag get() = sky
    val featureTag get() = olive
    val personalTag get() = kraft
}

private val LightPalette = with(CairnTokens.Light) {
    CairnPalette(Canvas, Surface, Secondary, Sand, SandHover, Warm, Manilla, Kraft, Ink, InkSoft, Muted, Tertiary, Faint,
        Hairline, HairlineSoft, Terracotta, TerracottaDeep, Clay, Fig, Olive, OliveInk, Cactus, Sky, Danger, OnAccent, isDark = false)
}
private val DarkPalette = with(CairnTokens.Dark) {
    CairnPalette(Canvas, Surface, Secondary, Sand, SandHover, Warm, Manilla, Kraft, Ink, InkSoft, Muted, Tertiary, Faint,
        Hairline, HairlineSoft, Terracotta, TerracottaDeep, Clay, Fig, Olive, OliveInk, Cactus, Sky, Danger, OnAccent, isDark = true)
}

private fun schemeOf(p: CairnPalette) = if (p.isDark) darkScheme(p) else lightScheme(p)
private fun lightScheme(p: CairnPalette) = lightColorScheme(
    primary = p.terracotta, onPrimary = p.onAccent,
    primaryContainer = p.manilla, onPrimaryContainer = p.ink,
    secondary = p.olive, onSecondary = p.onAccent,
    secondaryContainer = p.secondary, onSecondaryContainer = p.inkSoft,
    tertiary = p.fig, onTertiary = p.onAccent,
    tertiaryContainer = p.warm, onTertiaryContainer = p.ink,
    error = p.danger, onError = p.onAccent,
    errorContainer = Color(0xFFF3DED6), onErrorContainer = p.danger,
    background = p.canvas, onBackground = p.ink,
    surface = p.canvas, onSurface = p.ink,
    surfaceVariant = p.secondary, onSurfaceVariant = p.muted,
    surfaceContainerLowest = p.surface, surfaceContainerLow = p.surface,
    surfaceContainer = p.surface, surfaceContainerHigh = p.secondary, surfaceContainerHighest = p.sandHover,
    surfaceBright = p.surface, surfaceDim = p.sand,
    inverseSurface = p.ink, inverseOnSurface = p.canvas, inversePrimary = p.clay,
    outline = p.hairline, outlineVariant = p.hairlineSoft,
    scrim = Color(0x66141413),
)
private fun darkScheme(p: CairnPalette) = darkColorScheme(
    primary = p.terracotta, onPrimary = p.onAccent,
    primaryContainer = p.manilla, onPrimaryContainer = p.ink,
    secondary = p.olive, onSecondary = Color(0xFF141413),
    secondaryContainer = p.secondary, onSecondaryContainer = p.inkSoft,
    tertiary = p.fig, onTertiary = Color(0xFF141413),
    tertiaryContainer = p.warm, onTertiaryContainer = p.ink,
    error = p.danger, onError = Color(0xFF141413),
    errorContainer = Color(0xFF4A2A20), onErrorContainer = Color(0xFFF3C9BB),
    background = p.canvas, onBackground = p.ink,
    surface = p.canvas, onSurface = p.ink,
    surfaceVariant = p.secondary, onSurfaceVariant = p.muted,
    surfaceContainerLowest = p.sand, surfaceContainerLow = p.surface,
    surfaceContainer = p.surface, surfaceContainerHigh = p.secondary, surfaceContainerHighest = p.sandHover,
    surfaceBright = p.surface, surfaceDim = p.sand,
    inverseSurface = p.ink, inverseOnSurface = p.canvas, inversePrimary = p.terracottaDeep,
    outline = p.hairline, outlineVariant = p.hairlineSoft,
    scrim = Color(0x99000000),
)

private val AppShapes = Shapes(
    extraSmall = RoundedCornerShape(6.dp),
    small = RoundedCornerShape(CairnTokens.Radius.Btn),
    medium = RoundedCornerShape(CairnTokens.Radius.Field),
    large = RoundedCornerShape(CairnTokens.Radius.Card),
    extraLarge = RoundedCornerShape(CairnTokens.Radius.Modal),
)

/** UI text uses the system sans (DM Sans is not bundled); titles and reading use the serif. */
val CairnSerif: FontFamily = FontFamily.Serif

private val AppTypography = Typography(
    displaySmall = TextStyle(fontFamily = CairnSerif, fontSize = 30.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium, letterSpacing = (-0.02).em),
    headlineLarge = TextStyle(fontFamily = CairnSerif, fontSize = 26.sp, lineHeight = 33.sp, fontWeight = FontWeight.SemiBold, letterSpacing = (-0.02).em),
    headlineSmall = TextStyle(fontFamily = CairnSerif, fontSize = 22.sp, lineHeight = 29.sp, fontWeight = FontWeight.SemiBold, letterSpacing = (-0.015).em),
    titleLarge = TextStyle(fontFamily = CairnSerif, fontSize = 20.sp, lineHeight = 27.sp, fontWeight = FontWeight.SemiBold, letterSpacing = (-0.01).em),
    titleMedium = TextStyle(fontSize = 16.sp, lineHeight = 23.sp, fontWeight = FontWeight.Medium),
    titleSmall = TextStyle(fontSize = 14.sp, lineHeight = 20.sp, fontWeight = FontWeight.Medium),
    bodyLarge = TextStyle(fontFamily = CairnSerif, fontSize = 17.sp, lineHeight = 29.sp),
    bodyMedium = TextStyle(fontSize = 14.sp, lineHeight = 21.sp),
    bodySmall = TextStyle(fontSize = 12.5.sp, lineHeight = 18.sp),
    labelLarge = TextStyle(fontSize = 14.sp, lineHeight = 20.sp, fontWeight = FontWeight.Medium),
    labelMedium = TextStyle(fontSize = 12.sp, lineHeight = 16.sp, fontWeight = FontWeight.Medium),
    labelSmall = TextStyle(fontSize = 11.sp, lineHeight = 15.sp, fontWeight = FontWeight.Medium),
)

private val LocalCairnPalette = staticCompositionLocalOf { LightPalette }

object CairnTheme {
    val palette: CairnPalette
        @Composable get() = LocalCairnPalette.current
}

@Composable
internal fun CairnShareTheme(dark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    val palette = if (dark) DarkPalette else LightPalette
    CompositionLocalProvider(LocalCairnPalette provides palette) {
        MaterialTheme(colorScheme = schemeOf(palette), shapes = AppShapes, typography = AppTypography, content = content)
    }
}
