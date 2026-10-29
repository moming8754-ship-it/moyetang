package com.dongfangmoyetang.notes

import android.content.ContentValues
import android.content.Context
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import java.io.File

/**
 * 把导出的文件写进**用户看得见的**「下载/东方摩耶堂/」—— M27（v2.18.0）
 *
 * 为什么是 Kotlin 而不是 Rust 直接写文件：安卓 10+ 起是分区存储，普通应用**不许**直接往
 * `/sdcard/Download` 写；唯一干净的路是走 MediaStore 插入（系统代写、不需要任何权限）。
 * 而 Tauri 的 dialog 插件在安卓上**没有实现**「另存为」（源码里就一行 TODO），
 * 所以这条路只能自己铺。Rust 侧见 `src-tauri/src/android.rs`（JNI 调本对象）。
 *
 * ⚠️ 两个别改坏的点：
 * ① **用 `IS_PENDING`**：先占位、写完再置 0，否则文件在系统相册/文件管理里会显示成半截；
 * ② API < 29 走老路（直接写文件）—— 那条路要 `WRITE_EXTERNAL_STORAGE`，
 *    已在 AndroidManifest 里声明且 `maxSdkVersion="28"`（新系统上不申请、也不会弹权限框）。
 *
 * 抛出的异常会被 Rust 侧捕获：返回 null → Rust 读挂起异常、打 logcat、给用户一句中文错误。
 */
object DownloadSaver {
  /** 下载目录下的固定子目录（用户的导出都归到这儿） */
  private const val ROOT = "东方摩耶堂"

  /**
   * @param subdir 子目录（导出的图片放 `<笔记名>.assets`），空串 = 直接放根
   * @param displayName 文件名（含扩展名）
   * @param mime MIME 类型（MediaStore 用它决定"这是什么文件"）
   * @param bytes 文件内容
   * @return 给人看的路径，如 `下载/东方摩耶堂/笔记.md`
   */
  @JvmStatic
  fun save(
    context: Context,
    subdir: String,
    displayName: String,
    mime: String,
    bytes: ByteArray
  ): String {
    val sub = subdir.trim().trim('/')
    val relative = if (sub.isEmpty()) {
      "${Environment.DIRECTORY_DOWNLOADS}/$ROOT"
    } else {
      "${Environment.DIRECTORY_DOWNLOADS}/$ROOT/$sub"
    }

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      val values = ContentValues().apply {
        put(MediaStore.MediaColumns.DISPLAY_NAME, displayName)
        put(MediaStore.MediaColumns.MIME_TYPE, mime)
        put(MediaStore.MediaColumns.RELATIVE_PATH, relative)
        put(MediaStore.MediaColumns.IS_PENDING, 1)
      }
      val resolver = context.contentResolver
      val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
        ?: throw IllegalStateException("系统拒绝在下载目录里建文件：$relative/$displayName")
      resolver.openOutputStream(uri)?.use { it.write(bytes) }
        ?: throw IllegalStateException("打不开写入流：$uri")
      values.clear()
      values.put(MediaStore.MediaColumns.IS_PENDING, 0)
      resolver.update(uri, values, null, null)
      return if (sub.isEmpty()) "下载/$ROOT/$displayName" else "下载/$ROOT/$sub/$displayName"
    }

    val dir = File(
      Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS),
      if (sub.isEmpty()) ROOT else "$ROOT/$sub"
    )
    if (!dir.exists() && !dir.mkdirs()) {
      throw IllegalStateException("建目录失败：${dir.absolutePath}")
    }
    val file = File(dir, displayName)
    file.writeBytes(bytes)
    return file.absolutePath
  }
}
