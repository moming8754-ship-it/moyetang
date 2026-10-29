//! 全部数据结构（serde）。字段名一律 `camelCase`，与前端 TS 类型一一对应。
//!
//! 约定：结构与 `DEV-PLAN.md` §4 保持一致；加字段一律用 `#[serde(default)]`，
//! 这样旧文件缺字段也能读出来（**不要**让加字段变成"读不了老文件"）。

use serde::{Deserialize, Serialize};

/// 当前时间：ISO 8601 + 本地时区偏移 + 毫秒精度。
///
/// 所有时间戳都由后端盖章，格式统一；因为带的是同机同一个偏移，
/// **按字符串排序就等于按时间排序**，前端不用再解析成 Date 比较。
pub fn now_iso() -> String {
    chrono::Local::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, false)
}

// ─────────────────────────── 信息区 info.jsonl ───────────────────────────

/// 信息类型：纯文本 / 图片
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InfoKind {
    Text,
    Image,
}

impl Default for InfoKind {
    fn default() -> Self {
        Self::Text
    }
}

/// 信息状态：待处理 / 已联动
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InfoStatus {
    Pending,
    Linked,
}

impl Default for InfoStatus {
    fn default() -> Self {
        Self::Pending
    }
}

/// 联动去向（信息 → 认知笔记 / 待办）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Link {
    pub target_kind: LinkTargetKind,
    pub target_id: String,
    /// 目标标题快照：目标被删掉后界面上还能看出"当初联动到哪去了"
    #[serde(default)]
    pub title_snapshot: String,
    /// 联动时间（ISO）
    #[serde(default)]
    pub at: String,
}

/// 联动目标类型
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LinkTargetKind {
    Note,
    Todo,
}

/// 一条信息（`info.jsonl` 里的一行）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    /// uuid
    pub id: String,
    #[serde(default)]
    pub kind: InfoKind,
    /// 文本内容（图片类可为空，或写备注）
    #[serde(default)]
    pub text: String,
    /// 图片相对路径：`assets/xxxx.png`
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset_path: Option<String>,
    /// 创建时间（ISO 8601，带时区偏移，可直接按字符串排序）
    #[serde(default)]
    pub created_at: String,
    /// 最后一次修改时间；老数据没有这个字段 → 空串，同步时回退到 createdAt。
    #[serde(default)]
    pub updated_at: String,
    /// 信息分类（可多选，M2 用）
    #[serde(default)]
    pub categories: Vec<String>,
    #[serde(default)]
    pub status: InfoStatus,
    #[serde(default)]
    pub links: Vec<Link>,
}

// ─────────────────────────── 设置 config.json ───────────────────────────

/// 主题
///
/// M16-B：加了**七套配色**（用户给的色号；色号本身的真源是前端 `shared/themes.ts`）。
/// ⚠️ 后端**只负责把这几个字符串存下来**，颜色怎么算全在前端 —— 但这里**必须认得这些 id**，
/// 否则 `config_save` 会直接反序列化失败（2026-09-27 实测：前端能切、后端拒收，
/// 页面上报 "Uncaught (in promise)"，很难一眼看出是后端的锅）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    Light,
    Dark,
    System,
    /// 青瓷绿 × 月桂米
    Qingci,
    /// 暮山蓝 × 晚桃粉
    Mushan,
    /// 石榴红 × 奶杏白
    Shiliu,
    /// 松针绿 × 琥珀金
    Songzhen,
    /// 雾霭紫 × 燕麦白
    Wuyan,
    /// 豆沙粉 × 墨青灰
    Dousha,
    /// 酪黄 × 远山青
    Laohuang,
}

impl Default for Theme {
    fn default() -> Self {
        Self::Light
    }
}

/// 快捷键（M6 才真正注册，M1 先把值存起来）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Shortcuts {
    pub toggle_small_window: String,
    pub quick_info: String,
    pub open_home: String,
    pub open_todos: String,
    pub start_pomodoro: String,
}

impl Default for Shortcuts {
    fn default() -> Self {
        Self {
            toggle_small_window: "Ctrl+Space".to_string(),
            quick_info: String::new(),
            open_home: String::new(),
            open_todos: String::new(),
            start_pomodoro: String::new(),
        }
    }
}

/// 提醒开关（45 分钟信息提醒等）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RemindersConfig {
    pub info_stale_enabled: bool,
    pub info_stale_minutes: u32,
    // ───────── C 批（2026-10-02，用户脑图第 4 条）：提醒要有**明显的提示音** ─────────
    //
    // 用户原话：「45min 的提醒，要有更明显的闹钟声音，要可以自由设置音效」。
    // ⚠️ 声音**不去加音频文件、也不联网**（PRD 第一版就定的红线）——
    //    用 Web Audio 现场合成三档（见前端 `shared/sound.ts`），所以这里只存"选哪档 / 多响"。
    /// 提示音档位：`"ding"`（叮）| `"triple"`（三连叮）| `"low"`（低鸣）| `"none"`（静音）
    #[serde(default = "default_sound_kind")]
    pub sound_kind: String,
    /// 音量 0~100（默认 60；0 = 不出声）
    #[serde(default = "default_sound_volume")]
    pub sound_volume: u32,
    /// 响几声（1~5，默认 1）
    #[serde(default = "default_sound_times")]
    pub sound_times: u32,
}

fn default_sound_kind() -> String {
    "ding".to_string()
}

fn default_sound_volume() -> u32 {
    60
}

fn default_sound_times() -> u32 {
    1
}

impl Default for RemindersConfig {
    fn default() -> Self {
        Self {
            info_stale_enabled: true,
            info_stale_minutes: 45,
            sound_kind: default_sound_kind(),
            sound_volume: default_sound_volume(),
            sound_times: default_sound_times(),
        }
    }
}

/// 首页动态区显示开关（M7 用；首次不显示由前端按规则处理）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct HomeSticky {
    pub reminders: bool,
    pub single_day_itinerary: bool,
    pub recent_todos: bool,
    /// #8（2026-10-21）：十字待办（四象限）从执行区搬到首页 —— 这是一项常驻项。
    /// 默认 **true**（跟另外三项一致）；老 `config.json` 没有这个字段时读成 true。
    pub quadrant: bool,
}

impl Default for HomeSticky {
    fn default() -> Self {
        Self {
            reminders: true,
            single_day_itinerary: true,
            recent_todos: true,
            quadrant: true,
        }
    }
}

/// 小窗出现在哪儿（2026-09-21 用户拍板 B4："如果工作量不大，建议做成跟随鼠标"）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SmallPosition {
    /// 屏幕正中（M6 的行为）
    Center,
    /// 跟着鼠标走 —— 鼠标在哪就在哪附近弹出来
    Mouse,
}

impl Default for SmallPosition {
    fn default() -> Self {
        Self::Center
    }
}

/// 窗口行为设置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct WindowConfig {
    /// 唤起小窗时它出现在哪儿
    pub small_position: SmallPosition,
    /// 跟随鼠标时，窗口左上角相对光标的偏移（像素）—— 别让窗口正好压在光标下
    pub small_mouse_offset: i32,
    /// M10-3：关掉主窗口时**收进托盘**（true，默认）还是**直接退出**（false）。
    /// ⚠️ 老的 config.json 里没有这个键，而 `bool` 自己的默认值是 false ——
    /// 所以必须 `default_true`，否则老配置一读就变成"直接退出"，这一项等于白做。
    #[serde(default = "default_true")]
    pub close_to_tray: bool,
    /// M13-A：**专注小窗最后停在哪儿**（用户拖过就记住）。
    /// `None` = 还没摆过 → 第一次放到右下角。`#[serde(default)]` 老配置照读。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub focus_pos: Option<FocusPos>,
}

/// 专注小窗的位置（屏幕物理像素）
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusPos {
    pub x: i32,
    pub y: i32,
}

// ─────────────────────────── E 批：桌面挂件（2026-10-03） ───────────────────────────

/// 桌面挂件（类似 widget 的常驻展示）。
///
/// 用户原话：「类似 widget 的常驻展示……类似番茄 ToDo 的小组件功能，可以做到桌面上看见挂件。
/// 我想实现随时随地能看到格言、待办、日课（未来的倒数计时）的效果」。
/// 他 2026-10-03 点头的方向：**中号 + 普通置顶 + 与专注小窗不合并**。
///
/// ⚠️ 整个结构体 `#[serde(default)]` + `Default`：E 批之前写下的 `config.json` 里
/// 没有 `widget` 这一段，读出来必须是"**默认关**"（他得自己去设置里开）——
/// 而不是让 `bool` 自己默认成 false 也算"关"（碰巧一致），但 `size`/`show` 这些
/// 必须给对默认值，否则一开就是空白挂件。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WidgetConfig {
    /// 开不开（**默认关**：这种常驻的东西得用户主动要）
    pub enabled: bool,
    /// 尺寸：`"small"` 只格言 ｜ `"mid"` 格言+今日待办+番茄（默认）｜ `"big"` 再加时钟与信息
    pub size: String,
    /// 显示哪几格（`motto` / `todos` / `pomodoro` / `info` / `clock`）
    pub show: Vec<String>,
    /// 兼容旧配置：`desktop` 曾表示“真桌面层”，2026-10-27 用户明确不做；
    /// 现在实际统一按置顶浮窗运行。
    pub layer: String,
    /// 挂件最后停在哪儿（用户拖过就记住；`None` = 还没摆过 → 放右上角）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pos: Option<FocusPos>,
}

/// 挂件默认显示哪几格（中号的组合）
pub fn default_widget_show() -> Vec<String> {
    vec![
        "motto".to_string(),
        "todos".to_string(),
        "pomodoro".to_string(),
    ]
}

impl Default for WidgetConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            size: "mid".to_string(),
            show: default_widget_show(),
            layer: "top".to_string(),
            pos: None,
        }
    }
}

/// serde 用：字段缺失时当 true
pub fn default_true() -> bool {
    true
}

impl Default for WindowConfig {
    fn default() -> Self {
        Self {
            small_position: SmallPosition::default(),
            small_mouse_offset: 16,
            close_to_tray: true,
            focus_pos: None,
        }
    }
}

/// 专注 / 番茄钟设置（M13-B）。
///
/// ⚠️ 整个结构体标了 `#[serde(default)]` + `Default` 实现：M13-B 之前写下的
/// `config.json` 里没有 `focus` 这一段，读出来必须是这里的默认值（90 / true / true），
/// 而不是"关掉"（`bool` 自己的默认值是 false，这条坑项目里踩过，见进度.md 第四节）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FocusConfig {
    /// 多久没动键鼠算「疑似离开」（秒）；默认 90
    pub away_threshold_seconds: u64,
    /// 锁屏 / 休眠时自动暂停（用户 2026-09-26 定：只有这两种才自动暂停）
    pub pause_on_lock: bool,
    /// 番茄结束时问「计入 / 作废」；关掉就默认按「计入」记
    pub ask_on_finish: bool,
    /// M13-C：手动挑的格言「留一整天」—— 挑的那天（本地日期 `YYYY-MM-DD`）与格言 id。
    ///
    /// **当天**且那条格言还在 → 就用它；否则前端回到"今天这一句"自动挑。
    /// 空串 = 没挑过。⚠️ 后加字段 → `#[serde(default)]`，M13-C 之前写的 `config.json` 里没有它。
    #[serde(default)]
    pub motto_pick_date: String,
    /// M13-C：手动挑的那条格言的 id（见 [`FocusConfig::motto_pick_date`]）
    #[serde(default)]
    pub motto_pick_id: String,
    // ───────── C 批（2026-10-02，用户脑图第 8 条）：工作中定时提醒我一句 ─────────
    //
    // 用户原话：「执行区、工作时间进行时，随机时间弹出提醒我」。
    // ⚠️ "随机"我按**固定间隔**做（默认 45 分钟）—— 随机间隔在真用起来时只会让人没法预判；
    //    间隔他能在设置里改，等于给了他控制权。⚠️ 提示**只出现在专注小窗上**（不弹窗、不打断）。
    /// 开着吗（默认**关**：这种"定时念叨"必须让用户主动打开）
    #[serde(default)]
    pub work_prompt_enabled: bool,
    /// 每隔多少分钟提示一次（默认 45）
    #[serde(default = "default_work_prompt_minutes")]
    pub work_prompt_minutes: u32,
    // ───────── 2026-10-05（v1.14.0）：用户点名的"小齿轮里预设自定义时长" ─────────
    //
    // 用户原话：「可以在小齿轮那里设置自定义时间，不必再开始之后再设置」。
    // 以前只能进番茄面板、在时长那一行里现输一个数字（而且下一场又得重输）。
    /// 自定义番茄时长（分钟）：设置里预设一次，番茄面板打开时就按它开始（默认 25，跟原来的默认档一致）
    #[serde(default = "default_custom_minutes")]
    pub custom_minutes: u32,
}

fn default_custom_minutes() -> u32 {
    25
}

fn default_work_prompt_minutes() -> u32 {
    45
}

impl Default for FocusConfig {
    fn default() -> Self {
        Self {
            away_threshold_seconds: 90,
            pause_on_lock: true,
            ask_on_finish: true,
            // M13-C：没挑过 = 空串（不是 null：这俩字段是 String，不是 Option）
            motto_pick_date: String::new(),
            motto_pick_id: String::new(),
            work_prompt_enabled: false,
            work_prompt_minutes: default_work_prompt_minutes(),
            // 2026-10-05（v1.14.0）：番茄默认时长 —— 老 `config.json` 里没这个键时也读成 25
            custom_minutes: default_custom_minutes(),
        }
    }
}

/// 设置（`config.json`）。整个结构体标了 `#[serde(default)]`：
/// 文件里缺哪个字段就用默认值，**旧版本写下的配置文件照样能读**。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Config {
    pub theme: Theme,
    pub ui_font: String,
    pub body_font: String,
    pub font_size: u32,
    /// 数据目录（用户可在设置里改；同时会记一份到**默认目录**，供下次启动定位）
    pub data_dir: String,
    pub shortcuts: Shortcuts,
    pub reminders: RemindersConfig,
    pub home_sticky: HomeSticky,
    /// `backups/` 保留份数（M7）
    pub backup_keep: u32,
    /// 窗口行为（B4：小窗居中还是跟随鼠标）
    pub window: WindowConfig,
    /// 专注 / 番茄钟（M13-B：疑似离开阈值、锁屏自动暂停、结束时问不问）
    pub focus: FocusConfig,
    /// 档案区（M14-B：「启用档案区」—— 用户 2026-09-26 定：**默认关**）
    #[serde(default)]
    pub archive: ArchiveConfig,
    /// E 批（2026-10-03）：**桌面挂件**（类 widget 的常驻展示）
    #[serde(default)]
    pub widget: WidgetConfig,
    /// P2-D（2026-10-06）：手机文本页那颗**悬浮球**停在哪（球可拖，松手吸附左右边）
    #[serde(default)]
    pub mobile_toolbar_ball: MobileToolbarBall,
    /// 手机端：点开一篇笔记时的**默认模式** —— `"read"`（阅读，默认）或 `"edit"`（编辑）。
    ///
    /// 用户 2026-10-07 反馈原话：「为什么点击进去后是默认预览，我没说这个不好，只是不习惯，
    /// 应该在设置加一个可以修改的地方」→ 加这个开关。
    /// ⚠️ **只管手机端**：电脑端的笔记本体面板一直是编辑态、没人抱怨过，不擅自改。
    /// ⚠️ 取值只认 `"edit"`：别的（含老配置里根本没这个键）一律当 `"read"`。
    #[serde(default)]
    pub note_open_mode: String,
    /// 认知区列表的**默认折叠方式**（2026-10-11 用户反馈第 4 条）。
    ///
    /// 用户原话：「认知区打开后一大堆笔记……能不能设一个机制，可以去设置里调整是否默认把笔记
    /// 收成文件夹形式（还有一种愿景，我希望**分好类的笔记收进文件夹，没分类的笔记就打开**）」
    ///
    /// 取值：`"expand"`（**默认**，跟老行为一致：全部展开）/ `"collapse-grouped"`
    /// （分好类的收起来、没分类的展开 —— 他要的那种）。
    /// ⚠️ 只认这两个值，别的（含老配置里没这个键）一律当 `"expand"`。
    /// ⚠️ 它只是**初始形态**：用户在列表上手点过的折叠/展开，当次会话里以他点的为准
    ///    （重开程序才回到这个默认）。
    #[serde(default)]
    pub cognition_group_default: String,
    /// 编辑辅助栏显示哪些 Markdown 按钮、按什么顺序。
    ///
    /// 手机悬浮条里的撤销 / 重做 / 插图是固定功能，不在这个列表里。
    /// 老配置没有这个键时用完整默认表（12 颗），不能读成空栏。
    #[serde(default = "default_toolbar_actions")]
    pub toolbar_actions: Vec<String>,
}

pub fn default_toolbar_actions() -> Vec<String> {
    [
        "bold",
        "italic",
        "h1",
        "h2",
        "bullet",
        "ordered",
        "marker",
        "code",
        "spoiler",
        "strike",
        "link",
        "toc",
    ]
    .into_iter()
    .map(str::to_string)
    .collect()
}

impl Default for Config {
    fn default() -> Self {
        Self {
            theme: Theme::Light,
            ui_font: String::new(),
            body_font: String::new(),
            font_size: 16,
            data_dir: String::new(),
            shortcuts: Shortcuts::default(),
            reminders: RemindersConfig::default(),
            home_sticky: HomeSticky::default(),
            backup_keep: 5,
            window: WindowConfig::default(),
            focus: FocusConfig::default(),
            archive: ArchiveConfig::default(),
            widget: WidgetConfig::default(),
            mobile_toolbar_ball: MobileToolbarBall::default(),
            note_open_mode: "read".to_string(),
            cognition_group_default: "expand".to_string(),
            toolbar_actions: default_toolbar_actions(),
        }
    }
}

/// 手机文本页那颗「悬浮球」停在哪（P2-D / 2026-10-06）。
///
/// ⚠️ 存的是**哪一侧 + 距顶多少**，不是设计稿 v4 写的 `{x, y}`：
///    手机换机型 / 横竖屏切换时写死的 `x` 会落到屏幕外，`side` 不会（前端再把 `y` 夹进可视范围）。
/// ⚠️ 老配置里没有这一段 → 读出来必须是默认值（右侧、离顶 120px），
///    **不能变成"读不动老配置"**（这是本项目加配置字段的硬规矩）。
///
/// 为什么默认 120 而不是屏幕正中：竖排条有 500 多像素高，停在正中会**哪边都放不下**
/// （2026-10-06 实测：条被顶出屏幕上沿，最上面那颗「撤销」点不到）→ 默认停在偏上位置，
/// 条往下长，整条都在屏幕里。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MobileToolbarBall {
    /// `"left"` / `"right"`；别的值前端一律当 `"right"`
    pub side: String,
    /// 距屏幕顶部的像素
    pub y: i32,
}

impl Default for MobileToolbarBall {
    fn default() -> Self {
        Self {
            side: "right".to_string(),
            y: 120,
        }
    }
}

/// 档案区设置（M14-B）。
///
/// ⚠️ 整个结构体标了 `#[serde(default)]` + `Default` 实现：M14-B 之前写下的 `config.json`
/// 里没有 `archive` 这一段，读出来必须是 `false`（**关着**），而不是"读不动老配置"。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ArchiveConfig {
    /// 「启用档案区」—— 用户 2026-09-26 定：默认 false。
    /// 关着时认知区**不显示批注页签**；M15 做档案库入口时接同一个开关。
    pub enabled: bool,
}

impl Default for ArchiveConfig {
    fn default() -> Self {
        Self { enabled: false }
    }
}

// ─────────────────────────── 认知笔记 notes/<id>.json ───────────────────────────

/// 笔记类型：文本编辑器 / 树状图
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NoteKind {
    Doc,
    Tree,
}

impl Default for NoteKind {
    fn default() -> Self {
        Self::Doc
    }
}

/// 树状图节点（M4 补上"来源"字段，画布与三图标在 `store::tree` + 前端 `features/tree`）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeNode {
    pub id: String,
    #[serde(default)]
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset_path: Option<String>,
    #[serde(default)]
    pub collapsed: bool,
    #[serde(default)]
    pub children: Vec<TreeNode>,
    /// 这个节点是从哪条信息**联动**进来的（信息区 → 认知区，单向可见）。
    ///
    /// 只记一个 id：画布靠它在节点上显示「〔联动信息〕」来源标记、点它跳回信息区。
    /// 信息区那边看不到节点文字（它只有"已联动 → 认知区《XX》"的去向快照）。
    ///
    /// ⚠️ 旧笔记文件里没有这个字段，靠 `#[serde(default)]` 读成 `None`
    /// （守「加字段必须带 default」这条约定）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_info_id: Option<String>,
}

impl TreeNode {
    /// 造一个新节点（id 在这里统一生成，前端不自己造 uuid）
    pub fn new(text: impl Into<String>) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            text: text.into(),
            asset_path: None,
            collapsed: false,
            children: Vec::new(),
            source_info_id: None,
        }
    }
}

/// 一条认知笔记。Doc 用 `content`，Tree 用 `root`，两者共用同一套元信息。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: String,
    #[serde(default)]
    pub kind: NoteKind,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
    /// 联动进来的信息 id（信息区 → 认知区，单向可见）
    #[serde(default)]
    pub source_info_ids: Vec<String>,
    /// DocNote 正文（Markdown）
    #[serde(default)]
    pub content: String,
    /// TreeNote 根节点
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root: Option<TreeNode>,
    /// **分组名**（M8 方案 A）：空串 = 未分组。就是个标签，不做文件夹树。
    ///
    /// ⚠️ 必须 `#[serde(default)]`：M8 之前写下的笔记文件里没有这个字段，
    /// 少了它整篇笔记直接读不出来（这条规矩见进度.md 第四节）。
    #[serde(default)]
    pub group: String,
}

impl Note {
    /// 新建一条笔记（时间戳由后端盖章）
    pub fn new(kind: NoteKind, title: String) -> Self {
        let now = now_iso();
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            kind,
            title,
            created_at: now.clone(),
            updated_at: now,
            source_info_ids: Vec::new(),
            content: String::new(),
            root: if kind == NoteKind::Tree {
                // 根节点 = 中心主题（画布上它不能被删、也没有同级）
                Some(TreeNode::new("中心主题"))
            } else {
                None
            },
            group: String::new(),
        }
    }
}

// ─────────────────────────── 待办 todos.json ───────────────────────────

/// 待办状态（`done` 是"完成"，不是删除 —— 番茄钟结束也是标 done）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TodoStatus {
    Open,
    Done,
}

impl Default for TodoStatus {
    fn default() -> Self {
        Self::Open
    }
}

/// 四象限：重要且紧急 / 不重要但紧急 / 重要但不急 / 都不
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Quadrant {
    Q1,
    Q2,
    Q3,
    Q4,
}

/// 待办来源
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TodoSourceKind {
    /// 手动建的
    Manual,
    /// 认知笔记里的 `-[]文字` 自动检测出来的（M5）
    Note,
    /// 信息区联动过来的（M2）
    Info,
}

impl Default for TodoSourceKind {
    fn default() -> Self {
        Self::Manual
    }
}

/// 待办来源详情
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TodoSource {
    pub kind: TodoSourceKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note_id: Option<String>,
    /// 去重键。文本笔记是 `noteId + '#' + 归一化文本`，
    /// 树状图是 `noteId + '#' + nodeId + '#' + 归一化文本`（见 `marker.rs`）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub marker_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub marker_text: Option<String>,
    /// 标记所在行号（0 基；**树节点没有行号，是 `None`**）。
    /// **去重键里带文字，所以改一个字键就变了**；
    /// 靠行号 + 文字前缀判断"这是同一行的文字被改了"，就地改名而不是多出一条待办
    /// （编辑器是边打字边自动保存的，不然打一句话能生成一串待办）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub marker_line: Option<usize>,
    /// 这条标记长在哪个**树节点**上（M5；文本笔记是 `None`）。
    ///
    /// 树节点没有行号，改文字只能靠 node_id 认出"还是同一个节点"，
    /// 否则改一下节点里的措辞就会多冒一条待办。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_id: Option<String>,
    /// 来自哪条信息（M2 联动 B）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub info_id: Option<String>,
    /// **来源已移除**（M5-1）：认知区里那条 `-[]` 标记被删掉了。
    ///
    /// 待办**不删**、完成状态**不改** —— 用户很可能已经照着做完了，
    /// 程序悄悄删掉等于替他丢东西。只在界面上标一句「来源已移除」，
    /// 留还是删由他自己决定（`todo_delete`）。
    #[serde(default)]
    pub source_removed: bool,
    /// **用户在执行区手工改过这条待办的名字**（M11 前置 · 2026-09-26，用户拍板的方案①）。
    ///
    /// 笔记来源的待办，名字默认"跟着笔记里的 `-[]文字` 走"。用户一旦在执行区改过名，
    /// 就记上这一笔 —— 从此**名字归执行区**：`sync_markers` 不再拿笔记的文字覆盖它。
    ///
    /// ⚠️ 但**链接照旧跟着笔记走**：笔记那行文字改了 → 只把 `marker_key` / `marker_text` /
    /// 行号 / 节点续上新的，**名字一个字都不动**；标记被删了 → 照样标「来源已移除」。
    /// 为什么必须续链接：不续的话，笔记里那行稍微改一个字，同步就会当成"新标记"
    /// **另建一条待办**（重复），并把老的标成来源已移除。
    #[serde(default)]
    pub renamed: bool,
}

impl Default for TodoSource {
    fn default() -> Self {
        Self {
            kind: TodoSourceKind::Manual,
            note_id: None,
            marker_key: None,
            marker_text: None,
            marker_line: None,
            node_id: None,
            info_id: None,
            source_removed: false,
            renamed: false,
        }
    }
}

/// 一次番茄记录（M5）
///
/// `mode` 是 `countup` / `countdown` / `free`（正计时 / 倒计时 / 不计时）。
/// 用 `String` 而不是枚举：这一列**只作留档**，将来加模式不该让旧记录读不出来。
///
/// M13-B 加了 4 个「意外中断」字段（见各字段说明），**全部 `#[serde(default)]`**：
/// M13-B 之前写下的 `todos.json` 里没有这几个键，缺了也要照读。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pomodoro {
    #[serde(default)]
    pub mode: String,
    #[serde(default)]
    pub seconds: u32,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub at: String,
    /// **疑似离开**的累计秒数（M13-B）：这段时间键鼠一直没动（超过阈值），
    /// 但程序照常跑着 —— 人可能去倒水了，也可能是真的在别处干活。
    #[serde(default)]
    pub interrupted_seconds: u64,
    /// 超过阈值**算一次**，这是累计次数（不是"每一秒都算一次"，见 `focus::Tracker`）
    #[serde(default)]
    pub interrupted_times: u32,
    /// 锁屏 / 休眠**自动暂停**的累计秒数（用户 2026-09-26 定：只有这两种才自动暂停）
    #[serde(default)]
    pub paused_seconds: u64,
    /// 用户在这笔番茄结束时选了「**作废**」（不计入这一笔的账，但记录留档）
    #[serde(default)]
    pub voided: bool,
}

/// 记一次番茄时**额外带上**的那几个「意外中断」数字（M13-B）。
///
/// 为什么单独一个结构体、而不是给 `store::todo::add_pomodoro` 再排 4 个参数：
/// 这四项是一组（谁来都整组给），而且老调用方（与老单测）只要写
/// `PomodoroExtra::default()` 就等于"没有中断信息"，不必逐个数 4 个 0。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PomodoroExtra {
    pub interrupted_seconds: u64,
    pub interrupted_times: u32,
    pub paused_seconds: u64,
    pub voided: bool,
}

/// **重复规则**（M9-6）：这条待办做完了就再派一条下次的。
///
/// 刻意只有三档（每天 / 每周 / 每月）：
/// - 这是"习惯/周期性的事"，不是完整的 RRULE。用户要的是"别忘了"，不是排班表；
/// - 想要"每周一三五"那种，写三条待办比配一个规则更好懂。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Repeat {
    Daily,
    Weekly,
    Monthly,
}

/// 一条待办
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Todo {
    pub id: String,
    #[serde(default)]
    pub title: String,
    /// 拖动排序用的顺序号
    #[serde(default)]
    pub order: i64,
    /// 设定时间（今日时间轴用）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub planned_at: Option<String>,
    /// **截止日期**（M9-1）：最晚什么时候必须做完，过了就在卡片上标红。
    ///
    /// 和 `planned_at` 是两件事：前者是"我打算什么时候做"，这个是"最晚什么时候得完成"。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub due_at: Option<String>,
    #[serde(default)]
    pub status: TodoStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub done_at: Option<String>,
    /// 重要/紧急分类（M5 四象限）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quadrant: Option<Quadrant>,
    #[serde(default)]
    pub source: TodoSource,
    /// "再次设定时间提醒"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reminder_at: Option<String>,
    #[serde(default)]
    pub pomodoros: Vec<Pomodoro>,
    /// **子任务清单**（M9-2）：一条待办下面挂几个小步骤，卡片上显示 `2/5`。
    ///
    /// ⚠️ 后加的字段 → `#[serde(default)]`，M9 之前的 todos.json 里没有它。
    #[serde(default)]
    pub subtasks: Vec<Subtask>,
    /// **重复规则**（M9-6）：`None` = 不重复。
    ///
    /// 勾完这条，后端会**自动派一条下一次的**（时间往后推、子任务重置、状态回到未完成）。
    /// ⚠️ 后加字段 → `#[serde(default)]`。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repeat: Option<Repeat>,
    /// 这条是**从哪一条重复待办派出来的**（M9-6）。
    ///
    /// 唯一的用处是**防重复派发**：勾完 A 派了 B（`B.repeatFrom = A.id`），
    /// 再把 A 取消完成、又勾一次 —— 一看 B 已经在了就不再派。
    /// 没有这个字段的话，"来回勾"能滚出一长串一模一样的待办。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repeat_from: Option<String>,
    /// **「须知」**（M13-C）：这条待办的长期备注 —— 点开始专注时飘在小窗上的那行字
    /// （"这件事要干什么 / 有什么规则"）。
    ///
    /// ⚠️ **跟待办走，不跟番茄记录走**：番茄记的是"这一笔做了多久"，须知是"这件事本身要守什么"，
    /// 换个待办就该换一份。空串 = 没写（**不是删字段**）。
    /// ⚠️ 后加字段 → `#[serde(default)]`，M13-C 之前的 `todos.json` 里没有它。
    #[serde(default)]
    pub focus_note: String,
    /// **分组名**（V2 打磨 D 批，2026-10-04）：跟认知区那套一模一样 —— 就是个**标签**，
    /// 不做文件夹树、不支持嵌套。空串 = 未分组。
    ///
    /// ⚠️ 后加字段 → `#[serde(default)]`，D 批之前的 `todos.json` 里没有它（读进来是空串 = 未分组）。
    /// ⚠️ 改名/加组的规矩照 `Note.group`：`trim` + 最多 24 字（见 `store::todo::set_group`）。
    #[serde(default)]
    pub group: String,
    /// **这一条待办自己的番茄时长（分钟）**（v1.15.0，用户拍板的"B 语义"）。
    ///
    /// - `None` = **跟随设置里的全局值**（`config.focus.customMinutes`）；
    /// - `Some(n)` = 这条待办自己用 `n` 分钟（背单词 15、写作业 45，各设各的）。
    ///
    /// ⚠️ 后加字段 → `#[serde(default)]`；**同时**要 `skip_serializing_if`：
    /// 老规矩是**别往 `todos.json` 里写 `null`**（`TodoSource` 那几个 `Option` 也是这么办的）——
    /// 没设过的待办，文件里就该干干净净没有这个键。
    /// ⚠️ 合法区间 1~999 在 `store::todo::set_custom_minutes` 里把关（越界直接拒收）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_minutes: Option<u32>,
    /// 🆕 **M21（v2.11.0）：这条待办"最后一次改动时间"** —— 同步时判断"哪边的新"就靠它。
    ///
    /// 规矩（《同步协议》§5.3）：**任何改动都要把它刷新**（见 `store::todo` 里每个写路径的
    /// `touch`/`updated_at` 赋值）；新建时 = 创建时间。
    ///
    /// ⚠️ 后加字段 → `#[serde(default)]`：M21 之前的 `todos.json` 里没有它（读成空串），
    ///    由 `store::todo::load` 用 `created_at` 兜底 —— **绝不能让老文件读不出来**。
    #[serde(default)]
    pub updated_at: String,
    #[serde(default)]
    pub created_at: String,
}

/// 一条子任务（M9-2）
///
/// 刻意做得**很轻**：只有"写什么"和"做完了没"，不做嵌套、不做负责人、不做时间。
/// 需要更复杂的东西就该另开一条待办了 —— 子任务一复杂，人就不想用了。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Subtask {
    pub id: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub done: bool,
}

impl Subtask {
    pub fn new(text: String) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            text,
            done: false,
        }
    }
}

/// 待办集（`todos.json` 的顶层结构）
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TodoFile {
    pub items: Vec<Todo>,
}

// ─────────────────────────── 奖状 / 证书 awards.json（M12-A） ───────────────────────────

/// 一张奖状 / 证书。
///
/// 用户对这块的原话是"**允许你自由制造，核心是界面简洁轻松上手、给自己情绪价值**"，
/// 所以字段就四个（加上一张图和置顶），没有分类、没有评分、没有排行榜。
///
/// ⚠️ 全部字段 `#[serde(default)]`：这个文件以后只会加字段，**旧文件必须照读**。
/// ⚠️ `date` 故意是**自由文本**（`2026-08-14` / `2026 年 6 月` / 空都行）——
///    奖状不一定有确切日期，硬要 `YYYY-MM-DD` 等于逼用户编一个。
///    月份分段时从文本里抓前四位数字当年份；抓不到就归到"没写日期"那一段。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Award {
    pub id: String,
    pub title: String,
    /// 谁给的（"中国软件行业协会" / "自己发的" / 空）
    pub issuer: String,
    /// 什么时候（**自由文本**，见上面的说明）
    pub date: String,
    /// 写给自己的一句话（可空）
    pub note: String,
    /// 奖状图片在 `assets/` 里的相对路径（没图就是 `None` —— **没图也能建**）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset_path: Option<String>,
    /// 置顶（"我最得意的"永远排最前）
    pub pinned: bool,
    /// 最后修改时间（2026-10-21 · 奖状跨端更新）——
    /// 老数据没有这个字段 → 空串；同步时退回 `created_at`（见 `sync_apply::collect`）。
    /// 每次 `create` / `set` 都刷新它，同步靠它判"谁新"。
    pub updated_at: String,
    pub created_at: String,
}

/// `awards.json` 的顶层
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AwardFile {
    pub items: Vec<Award>,
}

// ─────────────────────────── 格言与原则 mottos.json（M12-C） ───────────────────────────

/// 一条格言 / 原则。
///
/// 用户对技能区的要求是"**界面简洁轻松上手、给自己情绪价值**"，所以字段只有两个：
/// **那句话** + **谁说的**（空着就显示"自己写给自己的"）。
///
/// ⚠️ **故意没有"置顶"** —— 他 2026-09-26 明确说"去掉置顶功能"（格言不该排序）。
/// ⚠️ 全部字段 `#[serde(default)]`：以后只会加字段，**旧文件必须照读**。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Motto {
    pub id: String,
    /// 那句话本身
    pub text: String,
    /// 谁说的 / 出处（可空；空着时界面按 `kind` 兜一句）
    pub from: String,
    /// `motto` = 别人的格言（带出处）／`rule` = 自己定下的原则
    pub kind: MottoKind,
    pub created_at: String,
    /// 最后一次修改时间；老数据缺失时同步回退到 createdAt。
    #[serde(default)]
    pub updated_at: String,
}

/// 两类：别人的话 vs 自己定的规矩
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MottoKind {
    /// 格言（别人的话）
    Motto,
    /// 原则（自己定下的规矩）
    Rule,
}

impl Default for MottoKind {
    fn default() -> Self {
        // 新写的默认当"自己的原则" —— 他主要是在给自己定规矩
        Self::Rule
    }
}

/// `mottos.json` 的顶层
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct MottoFile {
    pub items: Vec<Motto>,
}

// ─────────────────────────── 倒计时 countdowns.json（2026-10-04 · V2 打磨） ───────────────────────────

/// 一个倒计时 = **某个日子 + 它是什么事**，界面显示「还有 N 天」。
///
/// 用户脑图第 6 条里的"日课（未来的倒数计时）"就是它 ——
/// ⚠️ 但他 2026-10-04 明确说**名字就叫「倒计时」**，别写"日课"。
///
/// 两条设计约定：
/// 1. `date` **只到天**（`YYYY-MM-DD`），不存时刻 —— 倒计时是"离那天还有几天"，
///    存了时刻反而会出现"还有 0 天但已经过了"这种怪状态；
/// 2. `on_widget` 默认 **true**：写下来就是为了在挂件上看得见（要藏某一条再单独关）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Countdown {
    pub id: String,
    /// 「期末考」（一行字，最多 24 字）
    pub title: String,
    /// 目标日 `YYYY-MM-DD`
    pub date: String,
    /// 备注，可空
    pub note: String,
    /// 要不要显示在桌面挂件上（默认要）
    pub on_widget: bool,
    /// 最后一次修改时间；老数据缺失时同步回退到 date。
    #[serde(default)]
    pub updated_at: String,
}

impl Default for Countdown {
    fn default() -> Self {
        Self {
            id: String::new(),
            title: String::new(),
            date: String::new(),
            note: String::new(),
            // ⚠️ 这里是"新写一条"的默认：**默认上挂件**（`#[serde(default)]` 缺字段时也走这儿）
            on_widget: true,
            updated_at: String::new(),
        }
    }
}

/// `countdowns.json` 的顶层
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CountdownFile {
    pub items: Vec<Countdown>,
}

// ─────────────────────────── 批注 annotations.json（M14-B） ───────────────────────────

/// M14-B：一条批注。锚点**不存行号**（改一行就全错位），存"原文快照 + 前后文 + 句子哈希"。
///
/// 三者怎么配合（快路径 + 慢路径）：
/// 1. **快路径**：`hash` 命中 → 就是这一句，直接用；
/// 2. **慢路径**：没命中 → 拿 `quote` / `prefix` / `suffix` 在正文里重新找（改了别处的字，
///    这一句多半还在）；找不着才标成"锚点失效"。
///
/// ⚠️ 全部字段 `#[serde(default)]`：以后只会加字段，**旧文件必须照读**（老数据缺字段也照读）。
///
/// `PartialEq` 是给单测用的（"读回来跟建的那条一模一样"整条比，比逐个字段比更严）。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Annotation {
    pub id: String,
    /// 属于哪篇笔记
    pub note_id: String,
    /// 那句原文的快照（照原样存，用来显示"引的那一句"）
    pub quote: String,
    /// 原句**前 12 字**（改字后重新找位置用）
    pub prefix: String,
    /// 原句**后 12 字**
    pub suffix: String,
    /// 句子内容的哈希（快路径：没改过就直接命中）
    pub hash: String,
    /// 你写的批注正文
    pub text: String,
    pub created_at: String,
}

/// `annotations.json` 的顶层
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AnnotationFile {
    pub items: Vec<Annotation>,
}

// ─────────────────────────── 档案库 archive.json（M15） ───────────────────────────

/// M15：档案库里的一条。**存的是"整条快照"，不是"一个标题"**
/// （`DEV-PLAN-v2` 阶段 5 的「风险」那一格专门警告过这条）。
///
/// 为什么必须是整条快照：收进来的东西来源有**三种**（信息 / 笔记 / 待办），
/// 取出时要**逐项复原**回原来的区。只存个标题的话，取回去的是一条"空壳"——
/// 待办的番茄记录、子任务，笔记的正文，信息的分类 / 联动，全没了。
/// 所以 `snapshot` 就是**原记录原样的那一份 JSON**（`serde_json::Value`，不解析成结构体再拼回来），
/// 取出时照它写回原位；`title` / `summary` 只是**从快照里抽出来的投影**，方便列表不用反序列化。
///
/// ⚠️ 全部字段 `#[serde(default)]`：以后只会加字段，**旧文件必须照读**。
///
/// `PartialEq` 是给单测用的（"读回来跟收进去的那条一模一样"整条比，比逐个字段比更严）。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ArchiveEntry {
    /// 这条档案的 id —— **就是原记录的 id**
    /// （同一条东西只有一个 id，收纳 / 取出都按它找；取出时"还是那一条"，不是新的一条）
    pub id: String,
    /// 来源：`"info"` | `"note"` | `"todo"`（用 `String` 不用枚举：将来多一种来源，旧文件照读）
    pub kind: String,
    /// 列表上显示的标题（从快照里抽出来，方便列表不用反序列化）
    pub title: String,
    /// 一行摘要（信息取正文首行、待办取象限/状态、笔记取首行）
    pub summary: String,
    /// 🔴 **整条原记录的 JSON 快照**（原样存，取出时逐字段复原；`serde_json::Value`）
    pub snapshot: serde_json::Value,
    /// 收纳时间（ISO）
    pub archived_at: String,
    /// 最后一次修改时间（有快照更新时盖新章）；老数据缺失时同步回退到 archivedAt。
    #[serde(default)]
    pub updated_at: String,
    /// 你自己给这条档案写的一句话（可空）
    pub note: String,
}

/// `archive.json` 的顶层（照 `MottoFile` / `AwardFile` / `AnnotationFile` 一个模子）
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ArchiveFile {
    pub items: Vec<ArchiveEntry>,
}

// ─────────────────────────── 提醒 reminders.json ───────────────────────────

/// 提醒类型：信息放久了没联动 / 待办的"再次提醒"
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ReminderKind {
    InfoStale,
    TodoRemind,
}

/// 提醒状态
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReminderStatus {
    /// 已排期，到点就弹
    Pending,
    /// 已经弹过了（不重复弹）
    Fired,
    /// 用户选了"不再提醒"
    Dismissed,
}

impl Default for ReminderStatus {
    fn default() -> Self {
        Self::Pending
    }
}

/// 提醒要展示的内容
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ReminderPayload {
    pub text: String,
    pub category_text: String,
    /// C 批（2026-10-02）：这条提醒自己的一句说明，比如「提前 10 分钟」「再确认一遍」。
    ///
    /// 为什么放在载荷里而不是单开字段：它就是**给人看的一句话**，跟 `text` / `categoryText`
    /// 同一个层次；⚠️ 老 `reminders.json` 里没有它 → `#[serde(default)]` 读成空串。
    #[serde(default)]
    pub note: String,
}

/// 一条提醒
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reminder {
    pub id: String,
    pub kind: ReminderKind,
    /// 指向的信息 / 待办 id
    pub ref_id: String,
    /// 到点时间（ISO）
    pub fire_at: String,
    #[serde(default)]
    pub status: ReminderStatus,
    #[serde(default)]
    pub payload: ReminderPayload,
    /// "稍后提醒"用：到点后重新排期（走 `status=pending` + 新的 `fireAt`，这个字段只留痕）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snoozed_until: Option<String>,
    /// C 批（2026-10-02）：**这条提醒的"身份"** —— 同一条待办可以有**多条**提醒（用户脑图第 7 条）。
    ///
    /// 取值约定（前端不该自己拼字符串，规则只此一份）：
    /// - `"at:<ISO>"` —— 手动挑的那个时间点（同一条待办同一个时间点 → 改，不重复排）
    /// - `"early:<分钟>"` —— 提前 N 分钟提醒（相对这条待办的 `dueAt`）
    ///
    /// ⚠️ 老 `reminders.json` 里没有这个字段 → 空串。空串按"手动那条"处理（见
    /// `store::reminder::schedule_todo_remind` 里的兜底），**不会**把老提醒当成新的重排一遍。
    #[serde(default)]
    pub key: String,
}

/// 提醒集（`reminders.json` 的顶层结构）
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ReminderFile {
    pub items: Vec<Reminder>,
}

/// ISO 时间字符串加分钟数（解析失败时返回 None）
pub fn iso_plus_minutes(iso: &str, minutes: i64) -> Option<String> {
    let at = chrono::DateTime::parse_from_rfc3339(iso).ok()?;
    Some(
        (at + chrono::Duration::minutes(minutes))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, false),
    )
}

/// 比较两个 ISO 时间字符串的先后（解析失败时给 `None`，调用方自己决定怎么办）
pub fn iso_cmp(a: &str, b: &str) -> Option<std::cmp::Ordering> {
    let at = chrono::DateTime::parse_from_rfc3339(a).ok()?;
    let bt = chrono::DateTime::parse_from_rfc3339(b).ok()?;
    Some(at.cmp(&bt))
}

/// 从一段文字里取一个当标题的短句（待办标题、笔记标题都用它）
pub fn title_from_text(text: &str, max: usize) -> String {
    let one_line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let one_line = if one_line.is_empty() {
        text.replace('\n', " ").trim().to_string()
    } else {
        one_line
    };
    let chars: Vec<char> = one_line.chars().collect();
    if chars.len() > max {
        format!("{}…", chars[..max].iter().collect::<String>())
    } else {
        one_line
    }
}
