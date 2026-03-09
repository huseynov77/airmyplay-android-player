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
    private lateinit var cacheDir2: File

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
        cacheDir2 = File(filesDir, "media_cache")
        if (!cacheDir2.exists()) cacheDir2.mkdirs()

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

                // Allow file:// access for cached media
                allowFileAccessFromFileURLs = true
                allowUniversalAccessFromFileURLs = true
            }

            webViewClient = object : WebViewClient() {
                override fun onReceivedError(view: WebView?, request: WebResourceRequest?, error: WebResourceError?) {
                    // On network error for the main page, try reload after 5 seconds
                    if (request?.isForMainFrame == true) {
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

                // Allow console.log to show in logcat
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

        // Load from local assets
        webView.loadUrl("file:///android_asset/player/index.html")
    }

    // ============================================================
    // JavaScript Bridge — Media Cache
    // ============================================================
    inner class AndroidBridge {

        /**
         * Check if a URL is cached and return the local file path.
         * Returns empty string if not cached.
         */
        @JavascriptInterface
        fun getCachedPath(url: String): String {
            try {
                val fileName = md5(url) + getExtension(url)
                val file = File(cacheDir2, fileName)
                if (file.exists() && file.length() > 0) {
                    return file.absolutePath
                }
            } catch (e: Exception) {
                android.util.Log.e("AirmyplayCache", "getCachedPath error: ${e.message}")
            }
            return ""
        }

        /**
         * Download a media file to local cache.
         * Returns local file path on success, empty string on failure.
         * This runs on the JS thread — WebView handles threading.
         */
        @JavascriptInterface
        fun downloadMedia(url: String): String {
            try {
                val fileName = md5(url) + getExtension(url)
                val file = File(cacheDir2, fileName)

                // Already cached
                if (file.exists() && file.length() > 0) {
                    return file.absolutePath
                }

                // Download
                val tmpFile = File(cacheDir2, "$fileName.tmp")
                val connection = URL(url).openConnection() as HttpURLConnection
                connection.connectTimeout = 30000
                connection.readTimeout = 60000
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

        /**
         * Get cache statistics as JSON string.
         */
        @JavascriptInterface
        fun getCacheStats(): String {
            try {
                val files = cacheDir2.listFiles() ?: return "{}"
                val count = files.count { !it.name.endsWith(".tmp") }
                val totalSize = files.filter { !it.name.endsWith(".tmp") }.sumOf { it.length() }
                return """{"files":$count,"totalSizeMB":${totalSize / 1024 / 1024}}"""
            } catch (e: Exception) {
                return "{}"
            }
        }

        /**
         * Clear all cached media files.
         */
        @JavascriptInterface
        fun clearCache(): Boolean {
            try {
                val files = cacheDir2.listFiles() ?: return true
                files.forEach { it.delete() }
                android.util.Log.d("AirmyplayCache", "Cache cleared")
                return true
            } catch (e: Exception) {
                android.util.Log.e("AirmyplayCache", "Clear cache error: ${e.message}")
                return false
            }
        }

        /**
         * Get app version.
         */
        @JavascriptInterface
        fun getAppVersion(): String {
            return try {
                val pInfo = packageManager.getPackageInfo(packageName, 0)
                pInfo.versionName ?: "1.0.0"
            } catch (e: Exception) {
                "1.0.0"
            }
        }

        // ---- Helpers ----

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
                    // Only keep known media extensions
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

    // Handle TV remote keys
    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        when (keyCode) {
            // Back button — don't exit, stay in app
            KeyEvent.KEYCODE_BACK -> return true

            // D-pad keys — forward to WebView as keyboard events
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

            // Volume — let system handle
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
