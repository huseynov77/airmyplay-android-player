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
import androidx.webkit.WebViewAssetLoader
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

        // Fullscreen immersive — hide system bars
        enterImmersiveMode()

        // Keep screen on
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        // Wake lock for background
        val pm = getSystemService(POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "airmyplay:player")
        wakeLock?.acquire()

        // Media cache directory
        mediaCacheDir = File(filesDir, "media_cache")
        if (!mediaCacheDir.exists()) mediaCacheDir.mkdirs()

        // WebViewAssetLoader — serves assets via https:// to avoid CORS/file:// issues
        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        // WebView setup
        webView = WebView(this).apply {
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                mediaPlaybackRequiresUserGesture = false  // Autoplay videos
                cacheMode = WebSettings.LOAD_DEFAULT
                databaseEnabled = true
                allowFileAccess = true
                mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
                userAgentString = "$userAgentString AirmyplayAndroid/1.0"

                // Allow cross-origin requests from the asset loader domain
                allowFileAccessFromFileURLs = true
                allowUniversalAccessFromFileURLs = true
            }

            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?): WebResourceResponse? {
                    if (request == null) return super.shouldInterceptRequest(view, request)

                    val url = request.url.toString()

                    // Intercept cached media files (file:// paths returned by bridge)
                    if (url.startsWith("file:///")) {
                        try {
                            val path = url.removePrefix("file://")
                            val file = File(path)
                            if (file.exists()) {
                                val mimeType = when {
                                    path.endsWith(".mp4") -> "video/mp4"
                                    path.endsWith(".webm") -> "video/webm"
                                    path.endsWith(".ogg") -> "video/ogg"
                                    path.endsWith(".mov") -> "video/quicktime"
                                    path.endsWith(".jpg") || path.endsWith(".jpeg") -> "image/jpeg"
                                    path.endsWith(".png") -> "image/png"
                                    path.endsWith(".gif") -> "image/gif"
                                    path.endsWith(".webp") -> "image/webp"
                                    path.endsWith(".svg") -> "image/svg+xml"
                                    else -> "application/octet-stream"
                                }
                                return WebResourceResponse(mimeType, null, file.inputStream())
                            }
                        } catch (e: Exception) {
                            android.util.Log.e("Airmyplay", "File intercept error: ${e.message}")
                        }
                    }

                    // Let AssetLoader handle asset URLs
                    return assetLoader.shouldInterceptRequest(request.url)
                        ?: super.shouldInterceptRequest(view, request)
                }

                override fun onReceivedError(view: WebView?, request: WebResourceRequest?, error: WebResourceError?) {
                    if (request?.isForMainFrame == true) {
                        android.util.Log.e("Airmyplay", "Main frame error: ${error?.description}")
                        view?.postDelayed({ view.reload() }, 5000)
                    }
                }

                override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                    // Keep all navigation within the WebView
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

            // Add JavaScript bridge for media caching
            addJavascriptInterface(AndroidBridge(), "AndroidBridge")

            // Hardware acceleration
            setLayerType(View.LAYER_TYPE_HARDWARE, null)
        }

        setContentView(webView)

        // Load from WebViewAssetLoader (serves as https://appassets.androidplatform.net/assets/...)
        webView.loadUrl("https://appassets.androidplatform.net/assets/player/index.html")
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

                // Already cached
                if (file.exists() && file.length() > 0) {
                    return file.absolutePath
                }

                // Download
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

                // Rename tmp to final
                if (tmpFile.exists() && tmpFile.length() > 0) {
                    tmpFile.renameTo(file)
                    android.util.Log.d("AirmyplayCache", "Cached: $fileName (${file.length() / 1024}KB)")
                    return file.absolutePath
                }

            } catch (e: Exception) {
                android.util.Log.e("AirmyplayCache", "Download error for $url: ${e.message}")
            }
            return ""
        }

        @JavascriptInterface
        fun getCacheStats(): String {
            try {
                val files = mediaCacheDir.listFiles() ?: return "{}"
                val count = files.count { !it.name.endsWith(".tmp") }
                val totalSize = files.filter { !it.name.endsWith(".tmp") }.sumOf { it.length() }
                return """{"files":$count,"totalSizeMB":${totalSize / 1024 / 1024}}"""
            } catch (e: Exception) {
                return "{}"
            }
        }

        @JavascriptInterface
        fun clearCache(): Boolean {
            try {
                val files = mediaCacheDir.listFiles() ?: return true
                files.forEach { it.delete() }
                android.util.Log.d("AirmyplayCache", "Cache cleared")
                return true
            } catch (e: Exception) {
                return false
            }
        }

        @JavascriptInterface
        fun getAppVersion(): String {
            return try {
                val pInfo = packageManager.getPackageInfo(packageName, 0)
                pInfo.versionName ?: "1.0.0"
            } catch (e: Exception) {
                "1.0.0"
            }
        }

        private fun md5(input: String): String {
            val md = MessageDigest.getInstance("MD5")
            val digest = md.digest(input.toByteArray())
            return digest.joinToString("") { "%02x".format(it) }
        }

        private fun getExtension(url: String): String {
            try {
                val path = URL(url).path
                val lastDot = path.lastIndexOf(".")
                if (lastDot > 0) {
                    val ext = path.substring(lastDot).lowercase()
                    if (ext in listOf(".mp4", ".webm", ".ogg", ".mov", ".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg")) {
                        return ext
                    }
                }
            } catch (_: Exception) {}
            return ""
        }
    }

    // ============================================================
    // Immersive Mode
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
            KeyEvent.KEYCODE_DPAD_CENTER,
            KeyEvent.KEYCODE_ENTER -> {
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
            KeyEvent.KEYCODE_VOLUME_UP,
            KeyEvent.KEYCODE_VOLUME_DOWN -> return super.onKeyDown(keyCode, event)
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) enterImmersiveMode()
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
        enterImmersiveMode()
    }

    override fun onPause() {
        super.onPause()
        webView.onPause()
    }

    override fun onDestroy() {
        wakeLock?.release()
        webView.destroy()
        super.onDestroy()
    }
}
