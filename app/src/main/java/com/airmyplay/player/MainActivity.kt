package com.airmyplay.player

import android.annotation.SuppressLint
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

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        enterImmersiveMode()
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        val pm = getSystemService(POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "airmyplay:player")
        wakeLock?.acquire()

        mediaCacheDir = File(filesDir, "media_cache")
        if (!mediaCacheDir.exists()) mediaCacheDir.mkdirs()

        webView = WebView(this).apply {
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                mediaPlaybackRequiresUserGesture = false
                cacheMode = WebSettings.LOAD_DEFAULT
                databaseEnabled = true
                allowFileAccess = true
                mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
                userAgentString = "$userAgentString AirmyplayAndroid/1.0"
                allowFileAccessFromFileURLs = true
                allowUniversalAccessFromFileURLs = true
            }

            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?): WebResourceResponse? {
                    val url = request?.url?.toString() ?: return null

                    // Serve local player assets from https://player.local/
                    if (url.startsWith("https://player.local/")) {
                        val assetPath = "player/" + url.removePrefix("https://player.local/")
                        return serveAsset(assetPath)
                    }

                    // Serve cached media files via file:// paths
                    if (url.startsWith("file:///")) {
                        return serveCachedFile(url.removePrefix("file://"))
                    }

                    return null
                }

                override fun onReceivedError(view: WebView?, request: WebResourceRequest?, error: WebResourceError?) {
                    if (request?.isForMainFrame == true) {
                        android.util.Log.e("Airmyplay", "Main frame error: ${error?.description}")
                        view?.postDelayed({ view.reload() }, 5000)
                    }
                }

                override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                    return false
                }
            }

            webChromeClient = object : WebChromeClient() {
                override fun onShowCustomView(view: View?, callback: CustomViewCallback?) {
                    super.onShowCustomView(view, callback)
                }

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

        // Load HTML directly from assets — no network/DNS needed
        val html = assets.open("player/index.html").bufferedReader().readText()
        webView.loadDataWithBaseURL("https://player.local/", html, "text/html", "UTF-8", null)
    }

    // ============================================================
    // Asset & Cache serving
    // ============================================================
    private fun serveAsset(assetPath: String): WebResourceResponse? {
        return try {
            val inputStream = assets.open(assetPath)
            val mimeType = getMimeType(assetPath)
            val response = WebResourceResponse(mimeType, "UTF-8", inputStream)
            response.responseHeaders = mapOf(
                "Access-Control-Allow-Origin" to "*",
                "Cache-Control" to "no-cache"
            )
            response
        } catch (e: Exception) {
            android.util.Log.e("Airmyplay", "Asset not found: $assetPath")
            null
        }
    }

    private fun serveCachedFile(path: String): WebResourceResponse? {
        return try {
            val file = File(path)
            if (file.exists()) {
                val mimeType = getMimeType(path)
                val response = WebResourceResponse(mimeType, null, file.inputStream())
                response.responseHeaders = mapOf("Access-Control-Allow-Origin" to "*")
                response
            } else null
        } catch (e: Exception) {
            android.util.Log.e("Airmyplay", "Cache file error: ${e.message}")
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
    // JavaScript Bridge — Media Cache
    // ============================================================
    inner class AndroidBridge {

        @JavascriptInterface
        fun getCachedPath(url: String): String {
            try {
                val fileName = md5(url) + getExtension(url)
                val file = File(mediaCacheDir, fileName)
                if (file.exists() && file.length() > 0) {
                    return file.absolutePath
                }
            } catch (e: Exception) {
                android.util.Log.e("AirmyplayCache", "getCachedPath error: ${e.message}")
            }
            return ""
        }

        @JavascriptInterface
        fun downloadMedia(url: String): String {
            try {
                val fileName = md5(url) + getExtension(url)
                val file = File(mediaCacheDir, fileName)

                if (file.exists() && file.length() > 0) {
                    return file.absolutePath
                }

                val tmpFile = File(mediaCacheDir, "$fileName.tmp")
                val connection = URL(url).openConnection() as HttpURLConnection
                connection.connectTimeout = 30000
                connection.readTimeout = 60000
                connection.instanceFollowRedirects = true
                connection.connect()

                if (connection.responseCode != 200) {
                    connection.disconnect()
                    return ""
                }

                connection.inputStream.use { input ->
                    FileOutputStream(tmpFile).use { output ->
                        val buffer = ByteArray(8192)
                        var bytesRead: Int
                        while (input.read(buffer).also { bytesRead = it } != -1) {
                            output.write(buffer, 0, bytesRead)
                        }
                    }
                }

                connection.disconnect()

                if (tmpFile.exists() && tmpFile.length() > 0) {
                    tmpFile.renameTo(file)
                    android.util.Log.d("AirmyplayCache", "Cached: $fileName (${file.length() / 1024}KB)")
                    return file.absolutePath
                }
            } catch (e: Exception) {
                android.util.Log.e("AirmyplayCache", "Download error: ${e.message}")
            }
            return ""
        }

        @JavascriptInterface
        fun getCacheStats(): String {
            return try {
                val files = mediaCacheDir.listFiles() ?: return "{}"
                val count = files.count { !it.name.endsWith(".tmp") }
                val totalSize = files.filter { !it.name.endsWith(".tmp") }.sumOf { it.length() }
                """{"files":$count,"totalSizeMB":${totalSize / 1024 / 1024}}"""
            } catch (e: Exception) { "{}" }
        }

        @JavascriptInterface
        fun clearCache(): Boolean {
            return try {
                mediaCacheDir.listFiles()?.forEach { it.delete() }
                true
            } catch (e: Exception) { false }
        }

        @JavascriptInterface
        fun getAppVersion(): String {
            return try {
                packageManager.getPackageInfo(packageName, 0).versionName ?: "1.0.0"
            } catch (e: Exception) { "1.0.0" }
        }

        private fun md5(input: String): String {
            val digest = MessageDigest.getInstance("MD5").digest(input.toByteArray())
            return digest.joinToString("") { "%02x".format(it) }
        }

        private fun getExtension(url: String): String {
            return try {
                val path = URL(url).path
                val lastDot = path.lastIndexOf(".")
                if (lastDot > 0) {
                    val ext = path.substring(lastDot).lowercase()
                    if (ext in listOf(".mp4", ".webm", ".ogg", ".mov", ".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg")) ext else ""
                } else ""
            } catch (_: Exception) { "" }
        }
    }

    // ============================================================
    // Immersive Mode & Key Handling
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
        if (hasFocus) enterImmersiveMode()
    }

    override fun onResume() { super.onResume(); webView.onResume(); enterImmersiveMode() }
    override fun onPause() { super.onPause(); webView.onPause() }
    override fun onDestroy() { wakeLock?.release(); webView.destroy(); super.onDestroy() }
}
