/**
 * 图片文件 → base64。
 *
 * 为什么需要它：**剪贴板/拖放给的是字节，不是磁盘路径** —— 走不了 `asset_import`
 * （那个要一个真实路径），只能前端转 base64 交给 `asset_write_image`（后端按文件头魔数认格式）。
 *
 * 分块的原因：`String.fromCharCode(...arr)` 参数一多就爆栈（几千个还行，几十万必炸），
 * 所以按 32KB 一段一段拼。
 */
export async function fileToBase64(file: File): Promise<string> {
  const buffer = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const CHUNK = 0x8000;
  for (let offset = 0; offset < buffer.length; offset += CHUNK) {
    binary += String.fromCharCode(...buffer.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
}

/** 从剪贴板事件里挑出**图片文件**（没有就返回 null，让调用方走默认粘贴） */
export function imageFromClipboard(event: ClipboardEvent | React.ClipboardEvent): File | null {
  const items = event.clipboardData?.items;
  if (!items || items.length === 0) return null;
  const hit = Array.from(items).find(
    (one) => one.kind === "file" && one.type.startsWith("image/"),
  );
  return hit ? hit.getAsFile() : null;
}

/** 从拖放事件里挑出**图片文件**（没有就返回 null） */
export function imageFromDataTransfer(
  event: DragEvent | React.DragEvent,
): File | null {
  const files = event.dataTransfer?.files;
  if (!files || files.length === 0) return null;
  const hit = Array.from(files).find((one) => one.type.startsWith("image/"));
  return hit ?? null;
}

/** 把 `![](assets/…)` 插到光标处（拿不到光标就追加到末尾），返回新的正文与要放光标的位置 */
export function insertMarkdownAtCaret(
  body: string,
  insert: string,
  caret: number | null,
): { body: string; caret: number } {
  const at = caret === null || caret < 0 || caret > body.length ? body.length : caret;
  // 前后各补一个换行，免得图片挤在文字中间（跟着一起写进正文，用户想改随时改）
  const prefix = at > 0 && !body.slice(0, at).endsWith("\n") ? "\n" : "";
  const text = `${prefix}${insert}\n`;
  return { body: body.slice(0, at) + text + body.slice(at), caret: at + text.length };
}
