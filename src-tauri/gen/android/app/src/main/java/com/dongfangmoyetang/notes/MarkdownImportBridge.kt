package com.dongfangmoyetang.notes

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Base64
import android.util.Log
import android.widget.Toast
import org.json.JSONArray
import org.json.JSONObject

/**
 * 文件管理器里点「用东方摩耶堂打开 .md」时，Tauri 的 webview 可能还没起来；
 * 所以先把内容按 UTF-8 字节放进进程内队列，前端启动/回到前台后再轮询取走。
 */
object MarkdownImportBridge {
  private const val MAX_BYTES = 32 * 1024 * 1024
  private val pending = ArrayDeque<Pair<String, ByteArray>>()

  @JvmStatic
  fun capture(context: Context, intent: Intent?) {
    if (intent == null) return
    if (intent.action != Intent.ACTION_VIEW && intent.action != Intent.ACTION_SEND) return

    val uris = LinkedHashSet<Uri>()
    intent.data?.let(uris::add)
    @Suppress("DEPRECATION")
    (intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM))?.let(uris::add)
    intent.clipData?.let { clip ->
      for (index in 0 until clip.itemCount) clip.getItemAt(index).uri?.let(uris::add)
    }

    for (uri in uris) {
      try {
        val name = displayName(context, uri)
        if (!isSupported(name)) continue
        val bytes = context.contentResolver.openInputStream(uri)?.use { input ->
          val data = input.readBytes()
          if (data.size <= MAX_BYTES) data else null
        } ?: continue
        synchronized(pending) { pending.addLast(name to bytes) }
        Log.i("MarkdownImportBridge", "captured $name (${bytes.size} bytes)")
        Toast.makeText(context, "已接收：$name", Toast.LENGTH_SHORT).show()
      } catch (error: Exception) {
        // 单个文件读失败不影响其他文件；留下可见提示方便真机定位。
        Log.e("MarkdownImportBridge", "capture failed for $uri", error)
        Toast.makeText(context, "读取 Markdown 失败：${error.message ?: "未知错误"}", Toast.LENGTH_LONG).show()
      }
    }
  }

  @JvmStatic
  fun takePending(context: Context): String {
    val batch = synchronized(pending) {
      val copy = pending.toList()
      pending.clear()
      copy
    }
    Log.i("MarkdownImportBridge", "takePending ${batch.size}")
    val array = JSONArray()
    for ((name, bytes) in batch) {
      array.put(
        JSONObject()
          .put("name", name)
          .put("dataBase64", Base64.encodeToString(bytes, Base64.NO_WRAP)),
      )
    }
    return array.toString()
  }

  private fun displayName(context: Context, uri: Uri): String {
    var name = ""
    context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
      ?.use { cursor ->
        if (cursor.moveToFirst()) {
          val index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
          if (index >= 0) name = cursor.getString(index).orEmpty()
        }
      }
    if (name.isBlank()) name = uri.lastPathSegment?.substringAfterLast('/') ?: "导入的笔记.md"
    if (!name.contains('.')) name += ".md"
    return name
  }

  private fun isSupported(name: String): Boolean {
    val lower = name.lowercase()
    return lower.endsWith(".md") || lower.endsWith(".markdown") || lower.endsWith(".txt")
  }
}
