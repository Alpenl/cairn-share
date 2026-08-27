package com.alpenl.cairn.share.network

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdateApiClientTest {
    @Test
    fun semverComparisonUsesNumericParts() {
        assertTrue(SemVer.compare("0.1.5", "0.1.4") > 0)
        assertTrue(SemVer.compare("0.2.0", "0.10.0") < 0)
        assertEquals(0, SemVer.compare("1.2.3", "1.2.3"))
    }

    @Test
    fun parserFindsNewerApkAsset() {
        val result = ReleaseUpdateParser.parse(
            currentVersionName = "0.1.4",
            json = """
                {
                  "tag_name": "v0.1.5",
                  "html_url": "https://github.com/Alpenl/cairn-share/releases/tag/v0.1.5",
                  "assets": [
                    {
                      "name": "SHA256SUMS",
                      "browser_download_url": "https://github.com/Alpenl/cairn-share/releases/download/v0.1.5/SHA256SUMS"
                    },
                    {
                      "name": "cairn-share-android-0.1.5.apk",
                      "browser_download_url": "https://github.com/Alpenl/cairn-share/releases/download/v0.1.5/cairn-share-android-0.1.5.apk"
                    }
                  ]
                }
            """.trimIndent(),
        )

        assertTrue(result is UpdateCheckResult.Available)
        val update = (result as UpdateCheckResult.Available).update
        assertEquals("0.1.5", update.versionName)
        assertEquals(
            "https://github.com/Alpenl/cairn-share/releases/download/v0.1.5/cairn-share-android-0.1.5.apk",
            update.downloadUrl,
        )
    }

    @Test
    fun parserTreatsSameOrOlderReleaseAsUpToDate() {
        assertEquals(
            UpdateCheckResult.UpToDate,
            ReleaseUpdateParser.parse("0.1.5", releaseJson("v0.1.5")),
        )
        assertEquals(
            UpdateCheckResult.UpToDate,
            ReleaseUpdateParser.parse("0.1.5", releaseJson("v0.1.4")),
        )
    }

    @Test
    fun parserFailsClosedForInvalidVersions() {
        assertEquals(
            UpdateCheckResult.Failed,
            ReleaseUpdateParser.parse("0.1.4", releaseJson("nightly")),
        )
    }

    private fun releaseJson(tagName: String): String =
        """
            {
              "tag_name": "$tagName",
              "html_url": "https://github.com/Alpenl/cairn-share/releases/tag/$tagName",
              "assets": [
                {
                  "name": "cairn-share-android.apk",
                  "browser_download_url": "https://github.com/Alpenl/cairn-share/releases/download/$tagName/cairn-share-android.apk"
                }
              ]
            }
        """.trimIndent()
}
