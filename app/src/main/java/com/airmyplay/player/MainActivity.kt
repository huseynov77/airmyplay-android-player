package com.airmyplay.player

import android.annotation.SuppressLint
import android.content.pm.ActivityInfo
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.view.KeyEvent
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.webkit.*
import androidx.appcompat.app.AppCompatActivity
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private var wakeLock: PowerManager.WakeLock? = null
    private lateinit var mediaCacheDir: File

    companion object {
        // Use API domain as base URL to avoid CORS issues with fetch() calls
        const val BASE_URL = "https://backend-production-2fbb.up.railway.app/"
        val ASSET_FILES = setOf("index.html", "style.css", "player.js", "socket.io.min.js", "logo.svg", "favicon.svg")
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        try { enterImmersiveMode() } catch (_: Exception) {}
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        try {
            val pm = getSystemService(POWER_SERVICE) as PowerManager
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "airmyplay:player")
            wakeLock?.acquire(24 * 60 * 60 * 1000L)
        } catch (_: Exception) {}

        // Use external storage so files are visible in file manager
        // Path: /sdcard/Android/data/com.airmyplay.player/files/media_cache/
        val extDir = getExternalFilesDir(null)
        mediaCacheDir = File(extDir ?: filesDir, "media_cache")
        if (!mediaCacheDir.exists()) mediaCacheDir.mkdirs()

        // Migrate old internal cache to external (one-time)
        val oldCacheDir = File(filesDir, "media_cache")
        if (oldCacheDir.exists() && oldCacheDir.listFiles()?.isNotEmpty() == true) {
            try {
                oldCacheDir.listFiles()?.forEach { f ->
                    val dest = File(mediaCacheDir, f.name)
                    if (!dest.exists()) f.renameTo(dest) else f.delete()
                }
                oldCacheDir.delete()
            } catch (_: Exception) {}
        }

        webView = WebView(this).apply {
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                mediaPlaybackRequiresUserGesture = false
                cacheMode = WebSettings.LOAD_DEFAULT
                databaseEnabled = true
                mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
                userAgentString = "$userAgentString AirmyplayAndroid/1.0"
            }

            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?): WebResourceResponse? {
                    val url = request?.url?.toString() ?: return null

                    // Serve local player asset files (style.css, player.js, etc.)
                    if (url.startsWith(BASE_URL)) {
                        val path = url.removePrefix(BASE_URL)
                        if (ASSET_FILES.contains(path)) {
                            return serveAsset("player/$path")
                        }
                    }

                    // Serve cached media files
                    if (url.startsWith("https://airmyplay-cache.local/")) {
                        val path = url.removePrefix("https://airmyplay-cache.local/")
                        val file = File(mediaCacheDir, path)
                        if (file.exists()) {
                            return WebResourceResponse(getMimeType(path), null, file.inputStream())
                        }
                    }

                    // Everything else (API calls, socket.io, media URLs) goes to network
                    return null
                }

                override fun onReceivedError(view: WebView?, request: WebResourceRequest?, error: WebResourceError?) {
                    android.util.Log.e("Airmyplay", "WebView error: ${error?.description} URL: ${request?.url}")
                }

                override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                    // Never open external browser
                    return false
                }
            }

            webChromeClient = object : WebChromeClient() {
                override fun onConsoleMessage(consoleMessage: ConsoleMessage?): Boolean {
                    consoleMessage?.let {
                        android.util.Log.d("AirmyplayJS", "${it.message()} [${it.sourceId()}:${it.lineNumber()}]")
                    }
                    return true
                }
            }

            addJavascriptInterface(AndroidBridge(), "AndroidBridge")
            setLayerType(View.LAYER_TYPE_HARDWARE, null)
        }

        setContentView(webView)

        // Load HTML content directly — sub-resources fetched via shouldInterceptRequest
        try {
            val html = assets.open("player/index.html").bufferedReader().readText()
            webView.loadDataWithBaseURL(BASE_URL, html, "text/html", "UTF-8", null)
        } catch (e: Exception) {
            android.util.Log.e("Airmyplay", "Failed to load HTML: ${e.message}")
            webView.loadData("<h1>Error loading player</h1><p>${e.message}</p>", "text/html", "UTF-8")
        }
    }

    private fun serveAsset(assetPath: String): WebResourceResponse? {
        return try {
            val inputStream = assets.open(assetPath)
            val mimeType = getMimeType(assetPath)
            WebResourceResponse(mimeType, "UTF-8", inputStream)
        } catch (e: Exception) {
            android.util.Log.e("Airmyplay", "Asset not found: $assetPath")
            null
        }
    }

    private fun getMimeType(path: String): String {
        return when {
            path.endsWith(".html") -> "text/html"
            path.endsWith(".css") -> "text/css"
            path.endsWith(".js") -> "application/javascript"
            path.endsWith(".svg") -> "image/svg+xml"
            path.endsWith(".png") -> "image/png"
            path.endsWith(".jpg") || path.endsWith(".jpeg") -> "image/jpeg"
            path.endsWith(".gif") -> "image/gif"
            path.endsWith(".webp") -> "image/webp"
            path.endsWith(".mp4") -> "video/mp4"
            path.endsWith(".webm") -> "video/webm"
            path.endsWith(".ogg") -> "video/ogg"
            path.endsWith(".mov") -> "video/quicktime"
            path.endsWith(".json") -> "application/json"
            else -> "application/octet-stream"
        }
    }

    // ============================================================
    // JavaScript Bridge
    // ============================================================
    inner class AndroidBridge {

        @JavascriptInterface
        fun getCachedPath(url: String): String {
            try {
                val fileName = md5(url) + getExtension(url)
                val file = File(mediaCacheDir, fileName)
                if (file.exists() && file.length() > 0) {
                    // Return as interceptable URL, not file:// path
                    return "https://airmyplay-cache.local/$fileName"
                }
            } catch (_: Exception) {}
            return ""
        }

        @JavascriptInterface
        fun downloadMedia(url: String): String {
            try {
                val fileName = md5(url) + getExtension(url)
                val file = File(mediaCacheDir, fileName)
                if (file.exists() && file.length() > 0) {
                    return "https://airmyplay-cache.local/$fileName"
                }

                val tmpFile = File(mediaCacheDir, "$fileName.tmp")
                val conn = URL(url).openConnection() as HttpURLConnection
                conn.connectTimeout = 30000
                conn.readTimeout = 60000
                conn.instanceFollowRedirects = true
                conn.connect()

                if (conn.responseCode != 200) { conn.disconnect(); return "" }

                conn.inputStream.use { input ->
                    FileOutputStream(tmpFile).use { output ->
                        input.copyTo(output, 8192)
                    }
                }
                conn.disconnect()

                if (tmpFile.exists() && tmpFile.length() > 0) {
                    tmpFile.renameTo(file)
                    return "https://airmyplay-cache.local/$fileName"
                }
            } catch (e: Exception) {
                android.util.Log.e("AirmyplayCache", "Download: ${e.message}")
            }
            return ""
        }

        @JavascriptInterface
        fun getCacheStats(): String {
            return try {
                val files = mediaCacheDir.listFiles()?.filter { !it.name.endsWith(".tmp") } ?: emptyList()
                """{"files":${files.size},"totalSizeMB":${files.sumOf { it.length() } / 1024 / 1024}}"""
            } catch (_: Exception) { "{}" }
        }

        @JavascriptInterface
        fun clearCache(): Boolean {
            return try { mediaCacheDir.listFiles()?.forEach { it.delete() }; true } catch (_: Exception) { false }
        }

        @JavascriptInterface
        fun listCacheFiles(): String {
            return try {
                val files = mediaCacheDir.listFiles()?.filter { !it.name.endsWith(".tmp") } ?: emptyList()
                val list = files.sortedByDescending { it.lastModified() }.map { f ->
                    val sizeMB = String.format("%.2f", f.length().toDouble() / 1024 / 1024)
                    val ext = f.name.substringAfterLast(".", "?")
                    """{"name":"${f.name}","size":"${sizeMB} MB","ext":"$ext"}"""
                }
                "[${list.joinToString(",")}]"
            } catch (_: Exception) { "[]" }
        }

        @JavascriptInterface
        fun getCachePath(): String {
            return mediaCacheDir.absolutePath
        }

        @JavascriptInterface
        fun getAppVersion(): String {
            return try { packageManager.getPackageInfo(packageName, 0).versionName ?: "1.2.0" } catch (_: Exception) { "1.2.0" }
        }

        @JavascriptInterface
        fun setOrientation(orientation: String) {
            runOnUiThread {
                requestedOrientation = when (orientation.lowercase()) {
                    "portrait" -> ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
                    else -> ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
                }
            }
        }

        private fun md5(input: String): String {
            return MessageDigest.getInstance("MD5").digest(input.toByteArray()).joinToString("") { "%02x".format(it) }
        }

        private fun getExtension(url: String): String {
            return try {
                val ext = URL(url).path.substringAfterLast(".", "").lowercase()
                if (ext in listOf("mp4", "webm", "ogg", "mov", "jpg", "jpeg", "png", "gif", "webp", "svg")) ".$ext" else ""
            } catch (_: Exception) { "" }
        }
    }

    // ============================================================
    // Immersive & Keys
    // ============================================================
    private fun enterImmersiveMode() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.insetsController?.let {
                it.hide(WindowInsets.Type.systemBars())
                it.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = (
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                or View.SYSTEM_UI_FLAG_FULLSCREEN
                or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
            )
        }
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        when (keyCode) {
            KeyEvent.KEYCODE_BACK -> return true
            KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER -> {
                webView.evaluateJavascript("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter'}))", null)
                return true
            }
            KeyEvent.KEYCODE_DPAD_UP -> {
                webView.evaluateJavascript("document.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp'}))", null)
                return true
            }
            KeyEvent.KEYCODE_DPAD_DOWN -> {
                webView.evaluateJavascript("document.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown'}))", null)
                return true
            }
            KeyEvent.KEYCODE_VOLUME_UP, KeyEvent.KEYCODE_VOLUME_DOWN -> return super.onKeyDown(keyCode, event)
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) try { enterImmersiveMode() } catch (_: Exception) {}
    }

    override fun onResume() {
        super.onResume()
        try { webView.onResume() } catch (_: Exception) {}
        try { enterImmersiveMode() } catch (_: Exception) {}
    }

    override fun onPause() {
        super.onPause()
        try { webView.onPause() } catch (_: Exception) {}
    }

    override fun onDestroy() {
        try { wakeLock?.release() } catch (_: Exception) {}
        try { webView.destroy() } catch (_: Exception) {}
        super.onDestroy()
    }
}
