package com.dongfangmoyetang.notes

import android.content.Intent
import android.os.Bundle
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    // 先抓文件 Intent，再交给 TauriActivity：super 可能消费/替换它。
    MarkdownImportBridge.capture(applicationContext, intent)
    super.onCreate(savedInstanceState)
  }

  override fun onNewIntent(intent: Intent) {
    // 应用已打开时也先抓，再交给 TauriActivity。
    MarkdownImportBridge.capture(applicationContext, intent)
    super.onNewIntent(intent)
    setIntent(intent)
  }
}
