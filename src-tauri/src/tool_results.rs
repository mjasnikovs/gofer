//! The shape every answer is declared to have, and the one lookup that holds an answer to it.
#![allow(dead_code)]
//!
//! Written from `protocol/schemas/v2/params.json` and `commands.json`, where each operation and
//! each command says what its success answers with. Nothing here reaches the model: it is the
//! renderer's types and the editor's contract, generated from the row the summary already lives
//! in rather than kept in a second list nothing reconciles.
//!
//! Every field is read by serde and by nothing else, which is what the allow above is for.

// GENERATED-BEGIN results sha256:c9488a47681b764a
/// One node of a scene tree, and the nodes under it.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotNode {
    pub name: String,
    pub r#type: String,
    pub icon: String,
    pub path: String,
    pub children: Vec<GodotNode>,
}

/// A captured image, PNG bytes in base64.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotFrame {
    pub encoding: String,
    pub width: i64,
    pub height: i64,
    pub data: String,
}

/// The question the editor is waiting on, and the buttons it offers.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotEditorDialog {
    pub title: String,
    pub text: String,
    pub buttons: Vec<String>,
}

/// One setting a search answered with. `restartRequired` is a project setting fact; an editor setting carries none.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotSetting {
    pub name: String,
    pub value: serde_json::Value,
    #[serde(default)]
    pub restart_required: Option<bool>,
    #[serde(default)]
    pub means: Option<String>,
    #[serde(default)]
    pub choices: Option<Vec<String>>,
}

/// One property of a node in the edited scene, as the inspector would show it.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotProperty {
    pub name: String,
    pub value: serde_json::Value,
    pub r#type: String,
    pub class_name: String,
    pub stored: bool,
    pub writable: bool,
}

/// One property a batch write stored, read back off the node.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotPropertyWrite {
    pub node: String,
    pub property: String,
    pub value: serde_json::Value,
}

/// One event bound to an input action. `kind` says which of the other keys it carries.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotInputEvent {
    pub kind: String,
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default)]
    pub button: Option<String>,
    #[serde(default)]
    pub joypad_button: Option<String>,
    #[serde(default)]
    pub axis: Option<String>,
    #[serde(default)]
    pub axis_value: Option<f64>,
    #[serde(default)]
    pub description: Option<String>,
}

/// One action of the Input Map.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotInputAction {
    pub name: String,
    pub deadzone: f64,
    pub events: Vec<GodotInputEvent>,
    pub built_in: bool,
}

/// One autoload the project registers.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotAutoload {
    pub name: String,
    pub path: String,
    pub enabled: bool,
    pub gofer_managed: bool,
}

/// One editor plugin the project holds.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotPlugin {
    pub name: String,
    pub enabled: bool,
    pub gofer_managed: bool,
}

/// One painted cell of a TileMapLayer.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotCell {
    pub x: i64,
    pub y: i64,
    pub source: i64,
    pub atlas: Vec<i64>,
    pub alternative: i64,
}

/// How many cells one atlas tile draws.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotTileTally {
    pub atlas: Vec<i64>,
    pub count: i64,
}

/// One tile an atlas source defines, and whether it carries collision.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotTilesetTile {
    pub atlas: Vec<i64>,
    pub solid: bool,
}

/// One source of a TileSet. Only an atlas source carries a texture, a region size and a count.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotTilesetSource {
    pub id: i64,
    pub r#type: String,
    pub tiles: Vec<GodotTilesetTile>,
    pub truncated: bool,
    #[serde(default)]
    pub texture: Option<String>,
    #[serde(default)]
    pub region_size: Option<Vec<i64>>,
    #[serde(default)]
    pub count: Option<i64>,
}

/// One file a rescan named, and whether the editor took it in.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotRescannedFile {
    pub path: String,
    pub scanned: bool,
}

/// One persistent signal connection of the edited scene, in the shape node.connect_signal takes back.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotNodeConnection {
    pub node: String,
    pub signal: String,
    pub target: String,
    pub method: String,
    pub binds: Vec<serde_json::Value>,
    pub deferred: bool,
    pub one_shot: bool,
    pub persistent: bool,
}

/// The editor session the supervisor is holding, as the desktop reports it.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotSession {
    pub session_id: String,
    pub state: String,
    pub rpc_address: String,
    pub lsp_port: i64,
    pub dap_port: i64,
    #[serde(default)]
    pub godot_version: Option<String>,
    pub worktree: String,
}

/// One captured line of the session output.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotLogEntry {
    pub sequence: i64,
    pub source: String,
    pub severity: String,
    pub message: String,
    pub timestamp: i64,
}

/// One passage the documentation search ranked.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotDocsPassage {
    pub text: String,
    pub chapter: String,
    pub order: i64,
    pub score: f64,
    #[serde(default)]
    pub pinned: Option<bool>,
}

/// One chapter an answer drew on, and how well it scored.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotDocsChapter {
    pub chapter: String,
    pub score: f64,
}

/// One breakpoint as the adapter reports it back.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotVerifiedBreakpoint {
    pub path: String,
    #[serde(default)]
    pub line: Option<i64>,
    pub verified: bool,
    #[serde(default)]
    pub message: Option<String>,
}

/// Why the debuggee stopped, out of the adapter’s own stopped event.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotStoppedDetails {
    pub reason: String,
    #[serde(default)]
    pub thread_id: Option<i64>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub text: Option<String>,
    pub all_threads_stopped: bool,
}

/// One frame of a stack trace.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotDebugFrame {
    pub id: i64,
    pub name: String,
    pub line: i64,
    pub column: i64,
    #[serde(default)]
    pub path: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionGetStateResult {
    pub state: String,
    pub scene: String,
    pub revision: i64,
    pub dirty: bool,
    pub can_undo: bool,
    pub can_redo: bool,
    #[serde(default)]
    pub dialog: Option<GodotEditorDialog>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionCancelResult {
    pub request_id: String,
    pub cancelled: bool,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionQuitResult {
    pub quitting: bool,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionUndoResult {
    pub undo_depth: i64,
    pub redo_depth: i64,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionRedoResult {
    pub undo_depth: i64,
    pub redo_depth: i64,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionAnswerDialogResult {
    pub answered: String,
    pub dialog: GodotEditorDialog,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionGetUnsavedScenesResult {
    pub scenes: Vec<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionSaveAllScenesResult {
    pub saved: Vec<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectGetSettingsResult {
    pub project_name: String,
    pub main_scene: String,
    pub rendering_method: String,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectSearchSettingsResult {
    pub settings: Vec<GodotSetting>,
    pub total_matches: i64,
    pub truncated: bool,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectGetSettingResult {
    pub name: String,
    pub value: serde_json::Value,
    pub restart_required: bool,
    #[serde(default)]
    pub means: Option<String>,
    #[serde(default)]
    pub choices: Option<Vec<String>>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectSetSettingResult {
    pub name: String,
    pub saved: bool,
    pub created: bool,
    pub restart_required: bool,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectResetSettingResult {
    pub name: String,
    pub value: serde_json::Value,
    pub previous: serde_json::Value,
    pub changed: bool,
    pub restart_required: bool,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectListAutoloadsResult {
    pub autoloads: Vec<GodotAutoload>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectSetAutoloadResult {
    pub name: String,
    pub path: String,
    pub enabled: bool,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectRemoveAutoloadResult {
    pub name: String,
    pub removed: bool,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectListInputActionsResult {
    pub actions: Vec<GodotInputAction>,
    pub at_engine_default: Vec<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectSetInputActionResult {
    pub name: String,
    pub deadzone: f64,
    pub events: Vec<GodotInputEvent>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectRemoveInputActionResult {
    pub name: String,
    pub removed: bool,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectResetInputActionResult {
    pub name: String,
    pub reset: bool,
    pub restart_required: bool,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectListPluginsResult {
    pub plugins: Vec<GodotPlugin>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectSetPluginEnabledResult {
    pub plugin: String,
    pub enabled: bool,
    pub changed: bool,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditorSearchSettingsResult {
    pub settings: Vec<GodotSetting>,
    pub total_matches: i64,
    pub truncated: bool,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditorGetSettingResult {
    pub name: String,
    pub value: serde_json::Value,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditorSetSettingResult {
    pub name: String,
    pub machine_wide: bool,
    pub value: serde_json::Value,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditorGetClassIconsResult {
    pub encoding: String,
    pub icons: std::collections::HashMap<String, String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SceneListResult {
    pub scenes: Vec<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SceneOpenResult {
    pub scene: String,
    pub revision: i64,
    pub dirty: bool,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SceneCreateResult {
    pub scene: String,
    pub revision: i64,
    pub dirty: bool,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SceneSaveResult {
    pub scene: String,
    pub revision: i64,
    pub dirty: bool,
    pub wrote: bool,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SceneSaveAsResult {
    pub scene: String,
    pub revision: i64,
    pub dirty: bool,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SceneReloadResult {
    pub scene: String,
    pub revision: i64,
    pub dirty: bool,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SceneGetTreeResult {
    pub truncated: bool,
    #[serde(default)]
    pub root: Option<GodotNode>,
    pub revision: i64,
    pub scene: String,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeCreateResult {
    pub node: String,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeCreateNodesResult {
    pub nodes: Vec<String>,
    pub created: i64,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeInstantiateResult {
    pub node: String,
    pub path: String,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeDuplicateResult {
    pub node: String,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeRenameResult {
    pub node: String,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeReparentResult {
    pub node: String,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeChangeTypeResult {
    pub node: String,
    pub r#type: String,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeDeleteResult {
    pub deleted: bool,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeSetPropertyResult {
    pub node: String,
    pub property: String,
    pub value: serde_json::Value,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeSetPropertiesResult {
    pub properties: Vec<GodotPropertyWrite>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeAddToGroupResult {
    pub node: String,
    pub groups: Vec<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeRemoveFromGroupResult {
    pub node: String,
    pub groups: Vec<String>,
}

pub type NodeConnectSignalResult = GodotNodeConnection;

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeDisconnectSignalResult {
    pub node: String,
    pub signal: String,
    pub connected: bool,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeSetCellsResult {
    pub node: String,
    pub cells: i64,
    pub used_rect: Vec<i64>,
    pub tile_set: String,
    pub painted: i64,
    pub erased: i64,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeGetCellsResult {
    pub node: String,
    pub cells: i64,
    pub used_rect: Vec<i64>,
    pub tile_set: String,
    pub cells_listed: Vec<GodotCell>,
    pub tiles: Vec<GodotTileTally>,
    pub truncated: bool,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeInspectResult {
    pub name: String,
    pub r#type: String,
    pub path: String,
    pub properties: Vec<GodotProperty>,
    pub at_class_default: Vec<String>,
    pub groups: Vec<String>,
    pub signals: Vec<String>,
    pub connections: Vec<GodotNodeConnection>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceRescanResult {
    pub scanned: bool,
    pub files: Vec<GodotRescannedFile>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceCreateTilesetResult {
    pub path: String,
    pub texture: String,
    pub tile_size: Vec<i64>,
    pub grid: Vec<i64>,
    pub source: i64,
    pub tiles: Vec<Vec<i64>>,
    pub solid: Vec<Vec<i64>>,
    pub physics_layers: i64,
    pub replaced: bool,
    #[serde(default)]
    pub scanned: Option<bool>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceCreateTextureResult {
    pub scanned: bool,
    pub path: String,
    pub width: i64,
    pub height: i64,
    pub replaced: bool,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceCreateShapeResult {
    pub path: String,
    pub shape_type: String,
    pub replaced: bool,
    #[serde(default)]
    pub scanned: Option<bool>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceDescribeTilesetResult {
    pub path: String,
    pub tile_size: Vec<i64>,
    pub physics_layers: i64,
    pub sources: Vec<GodotTilesetSource>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionHeartbeatResult {}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeRunResult {
    pub running: bool,
    #[serde(default)]
    pub frame: Option<GodotFrame>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeStopResult {
    pub running: bool,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeRestartResult {
    pub running: bool,
    #[serde(default)]
    pub frame: Option<GodotFrame>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeGetStateResult {
    pub running: bool,
    pub runtime_ready: bool,
    pub broke: bool,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeGetTreeResult {
    pub truncated: bool,
    pub root: GodotNode,
    pub paused: bool,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeInspectNodeResult {
    pub path: String,
    pub name: String,
    pub r#type: String,
    pub properties: std::collections::HashMap<String, serde_json::Value>,
    pub groups: Vec<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeInputResult {
    pub applied: i64,
    #[serde(default)]
    pub frame: Option<GodotFrame>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeCaptureResult {
    pub frame: GodotFrame,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeGetMonitorsResult {
    pub monitors: std::collections::HashMap<String, f64>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeWaitResult {
    #[serde(default)]
    pub frames: Option<i64>,
    #[serde(default)]
    pub ms: Option<i64>,
    pub exited: bool,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimePauseResult {
    pub paused: bool,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeResumeResult {
    pub paused: bool,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotSessionStatusResult {
    #[serde(default)]
    pub session: Option<GodotSession>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotSessionStartResult {
    #[serde(default)]
    pub session: Option<GodotSession>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotSessionStopResult {
    pub stopped: bool,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotResourceListResult {
    pub files: Vec<GodotResourceListResultFiles>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotResourceMoveResult {
    pub from: String,
    pub to: String,
    pub moved: bool,
    pub also_moved: Vec<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotResourceDeleteResult {
    pub path: String,
    pub deleted: bool,
    pub also_removed: Vec<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotScriptListResult {
    pub files: Vec<GodotScriptListResultFiles>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotScriptOpenResult {
    pub files: Vec<GodotScriptOpenResultFiles>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotScriptUpdateResult {
    pub path: String,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotScriptEditResult {
    pub files: Vec<GodotScriptEditResultFiles>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotScriptSaveResult {
    pub path: String,
    pub bytes: i64,
    pub diagnostics: Vec<serde_json::Map<String, serde_json::Value>>,
    pub published: bool,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotScriptCloseResult {
    pub files: Vec<GodotScriptCloseResultFiles>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotScriptFormatResult {
    pub formatted: String,
    pub changed: bool,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotScriptHoverResult {
    pub op: String,
    #[serde(default)]
    pub hover: Option<serde_json::Map<String, serde_json::Value>>,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotScriptCompletionResult {
    pub op: String,
    pub items: Vec<serde_json::Map<String, serde_json::Value>>,
    pub is_incomplete: bool,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotScriptSignatureHelpResult {
    pub op: String,
    #[serde(default)]
    pub signature_help: Option<serde_json::Map<String, serde_json::Value>>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotScriptDefinitionResult {
    pub op: String,
    pub locations: Vec<GodotScriptDefinitionResultLocations>,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotScriptDeclarationResult {
    pub op: String,
    pub locations: Vec<GodotScriptDeclarationResultLocations>,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotScriptReferencesResult {
    pub op: String,
    pub locations: Vec<GodotScriptReferencesResultLocations>,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotScriptHighlightsResult {
    pub op: String,
    pub highlights: Vec<serde_json::Map<String, serde_json::Value>>,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotScriptDiagnosticsResult {
    pub files: Vec<GodotScriptDiagnosticsResultFiles>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotScriptDocumentSymbolsResult {
    pub op: String,
    pub symbols: Vec<serde_json::Map<String, serde_json::Value>>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotScriptWorkspaceSymbolsResult {
    pub op: String,
    pub symbols: Vec<GodotScriptWorkspaceSymbolsResultSymbols>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotScriptPrepareRenameResult {
    pub op: String,
    #[serde(default)]
    pub range: Option<serde_json::Map<String, serde_json::Value>>,
    #[serde(default)]
    pub placeholder: Option<String>,
    pub renameable: bool,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotScriptRenameResult {
    pub op: String,
    pub files: Vec<GodotScriptRenameResultFiles>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotScriptApplyRenameResult {
    pub files: Vec<GodotScriptApplyRenameResultFiles>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotDebugStatusResult {
    pub op: String,
    pub capabilities: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotDebugSetBreakpointsResult {
    pub op: String,
    pub breakpoints: Vec<GodotVerifiedBreakpoint>,
    #[serde(default)]
    pub armed: Option<Vec<String>>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotDebugBreakpointLocationsResult {
    pub op: String,
    pub locations: Vec<GodotDebugBreakpointLocationsResultLocations>,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotDebugLaunchResult {
    pub op: String,
    pub breakpoints: Vec<GodotVerifiedBreakpoint>,
    #[serde(default)]
    pub armed: Option<Vec<String>>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotDebugAttachResult {
    pub op: String,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotDebugAwaitStopResult {
    pub op: String,
    #[serde(default)]
    pub stopped: Option<GodotStoppedDetails>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotDebugThreadsResult {
    pub op: String,
    pub threads: Vec<GodotDebugThreadsResultThreads>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotDebugStackTraceResult {
    pub op: String,
    pub frames: Vec<GodotDebugFrame>,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotDebugScopesResult {
    pub op: String,
    pub scopes: Vec<GodotDebugScopesResultScopes>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotDebugVariablesResult {
    pub op: String,
    pub variables: Vec<GodotDebugVariablesResultVariables>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotDebugEvaluateResult {
    pub op: String,
    pub result: String,
    #[serde(default)]
    pub r#type: Option<String>,
    pub variables_reference: i64,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotDebugContinueResult {
    pub op: String,
    pub all_threads: bool,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotDebugPauseResult {
    pub op: String,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotDebugStepOverResult {
    pub op: String,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotDebugStepInResult {
    pub op: String,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotDebugStepOutResult {
    pub op: String,
    pub outcome: GodotDebugStepOutResultOutcome,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotDebugRestartResult {
    pub op: String,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotDebugTerminateResult {
    pub op: String,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotDebugDisconnectResult {
    pub op: String,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotLogsReadResult {
    pub entries: Vec<GodotLogEntry>,
    pub cursor: i64,
    pub dropped: i64,
    pub terminal_lines_omitted: i64,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotDocsSearchSearchResult {
    #[serde(default)]
    pub passages: Option<Vec<GodotDocsPassage>>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub excerpt_verified: Option<bool>,
    #[serde(default)]
    pub chapters: Option<Vec<GodotDocsChapter>>,
    #[serde(default)]
    pub coverage_miss: Option<bool>,
    #[serde(default)]
    pub abstained: Option<bool>,
    #[serde(default)]
    pub reader_unavailable: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotDocsSearchAskResult {
    #[serde(default)]
    pub passages: Option<Vec<GodotDocsPassage>>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub excerpt_verified: Option<bool>,
    #[serde(default)]
    pub chapters: Option<Vec<GodotDocsChapter>>,
    #[serde(default)]
    pub coverage_miss: Option<bool>,
    #[serde(default)]
    pub abstained: Option<bool>,
    #[serde(default)]
    pub reader_unavailable: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotResourceListResultFiles {
    pub path: String,
    pub bytes: i64,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotScriptListResultFiles {
    pub path: String,
    pub bytes: i64,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotScriptOpenResultFiles {
    pub path: String,
    pub bytes: i64,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub omitted: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotScriptEditResultFiles {
    pub path: String,
    pub bytes: i64,
    pub replaced: i64,
    pub diagnostics: Vec<serde_json::Map<String, serde_json::Value>>,
    pub published: bool,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotScriptCloseResultFiles {
    pub path: String,
    pub closed: bool,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotScriptDefinitionResultLocations {
    pub path: String,
    pub range: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotScriptDeclarationResultLocations {
    pub path: String,
    pub range: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotScriptReferencesResultLocations {
    pub path: String,
    pub range: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotScriptDiagnosticsResultFiles {
    pub path: String,
    pub diagnostics: Vec<serde_json::Map<String, serde_json::Value>>,
    pub published: bool,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotScriptWorkspaceSymbolsResultSymbols {
    pub name: String,
    pub kind: i64,
    pub uri: String,
    pub range: serde_json::Map<String, serde_json::Value>,
    #[serde(default)]
    pub container: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotScriptRenameResultFiles {
    pub path: String,
    pub original_text: String,
    pub original_hash: String,
    pub updated_text: String,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotScriptApplyRenameResultFiles {
    pub path: String,
    pub bytes: i64,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotDebugBreakpointLocationsResultLocations {
    pub line: i64,
    #[serde(default)]
    pub end_line: Option<i64>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotDebugThreadsResultThreads {
    pub id: i64,
    pub name: String,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotDebugScopesResultScopes {
    pub name: String,
    #[serde(default)]
    pub presentation_hint: Option<String>,
    pub variables_reference: i64,
    pub expensive: bool,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotDebugVariablesResultVariables {
    pub name: String,
    pub value: String,
    #[serde(default)]
    pub r#type: Option<String>,
    pub variables_reference: i64,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GodotDebugStepOutResultOutcome {
    pub kind: String,
    #[serde(default)]
    pub stop: Option<GodotStoppedDetails>,
}

/// Whether an answer is the shape its command or operation declared, and how it is not.
///
/// The name is an addon command — `scene.get_tree` — or a tool operation the desktop
/// answers itself, written `godot_script.edit`.
pub(crate) fn declared_shape_of(name: &str, answer: &serde_json::Value) -> Result<(), String> {
    fn shaped<T: serde::de::DeserializeOwned>(answer: &serde_json::Value) -> Result<(), String> {
        serde_json::from_value::<T>(answer.clone())
            .map(|_| ())
            .map_err(|why| why.to_string())
    }
    match name {
        "session.get_state" => shaped::<SessionGetStateResult>(answer),
        "session.cancel" => shaped::<SessionCancelResult>(answer),
        "session.quit" => shaped::<SessionQuitResult>(answer),
        "session.undo" => shaped::<SessionUndoResult>(answer),
        "session.redo" => shaped::<SessionRedoResult>(answer),
        "session.answer_dialog" => shaped::<SessionAnswerDialogResult>(answer),
        "session.get_unsaved_scenes" => shaped::<SessionGetUnsavedScenesResult>(answer),
        "session.save_all_scenes" => shaped::<SessionSaveAllScenesResult>(answer),
        "project.get_settings" => shaped::<ProjectGetSettingsResult>(answer),
        "project.search_settings" => shaped::<ProjectSearchSettingsResult>(answer),
        "project.get_setting" => shaped::<ProjectGetSettingResult>(answer),
        "project.set_setting" => shaped::<ProjectSetSettingResult>(answer),
        "project.reset_setting" => shaped::<ProjectResetSettingResult>(answer),
        "project.list_autoloads" => shaped::<ProjectListAutoloadsResult>(answer),
        "project.set_autoload" => shaped::<ProjectSetAutoloadResult>(answer),
        "project.remove_autoload" => shaped::<ProjectRemoveAutoloadResult>(answer),
        "project.list_input_actions" => shaped::<ProjectListInputActionsResult>(answer),
        "project.set_input_action" => shaped::<ProjectSetInputActionResult>(answer),
        "project.remove_input_action" => shaped::<ProjectRemoveInputActionResult>(answer),
        "project.reset_input_action" => shaped::<ProjectResetInputActionResult>(answer),
        "project.list_plugins" => shaped::<ProjectListPluginsResult>(answer),
        "project.set_plugin_enabled" => shaped::<ProjectSetPluginEnabledResult>(answer),
        "editor.search_settings" => shaped::<EditorSearchSettingsResult>(answer),
        "editor.get_setting" => shaped::<EditorGetSettingResult>(answer),
        "editor.set_setting" => shaped::<EditorSetSettingResult>(answer),
        "editor.get_class_icons" => shaped::<EditorGetClassIconsResult>(answer),
        "scene.list" => shaped::<SceneListResult>(answer),
        "scene.open" => shaped::<SceneOpenResult>(answer),
        "scene.create" => shaped::<SceneCreateResult>(answer),
        "scene.save" => shaped::<SceneSaveResult>(answer),
        "scene.save_as" => shaped::<SceneSaveAsResult>(answer),
        "scene.reload" => shaped::<SceneReloadResult>(answer),
        "scene.get_tree" => shaped::<SceneGetTreeResult>(answer),
        "node.create" => shaped::<NodeCreateResult>(answer),
        "node.create_nodes" => shaped::<NodeCreateNodesResult>(answer),
        "node.instantiate" => shaped::<NodeInstantiateResult>(answer),
        "node.duplicate" => shaped::<NodeDuplicateResult>(answer),
        "node.rename" => shaped::<NodeRenameResult>(answer),
        "node.reparent" => shaped::<NodeReparentResult>(answer),
        "node.change_type" => shaped::<NodeChangeTypeResult>(answer),
        "node.delete" => shaped::<NodeDeleteResult>(answer),
        "node.set_property" => shaped::<NodeSetPropertyResult>(answer),
        "node.set_properties" => shaped::<NodeSetPropertiesResult>(answer),
        "node.add_to_group" => shaped::<NodeAddToGroupResult>(answer),
        "node.remove_from_group" => shaped::<NodeRemoveFromGroupResult>(answer),
        "node.connect_signal" => shaped::<NodeConnectSignalResult>(answer),
        "node.disconnect_signal" => shaped::<NodeDisconnectSignalResult>(answer),
        "node.set_cells" => shaped::<NodeSetCellsResult>(answer),
        "node.get_cells" => shaped::<NodeGetCellsResult>(answer),
        "node.inspect" => shaped::<NodeInspectResult>(answer),
        "resource.rescan" => shaped::<ResourceRescanResult>(answer),
        "resource.create_tileset" => shaped::<ResourceCreateTilesetResult>(answer),
        "resource.create_texture" => shaped::<ResourceCreateTextureResult>(answer),
        "resource.create_shape" => shaped::<ResourceCreateShapeResult>(answer),
        "resource.describe_tileset" => shaped::<ResourceDescribeTilesetResult>(answer),
        "session.heartbeat" => shaped::<SessionHeartbeatResult>(answer),
        "runtime.run" => shaped::<RuntimeRunResult>(answer),
        "runtime.stop" => shaped::<RuntimeStopResult>(answer),
        "runtime.restart" => shaped::<RuntimeRestartResult>(answer),
        "runtime.get_state" => shaped::<RuntimeGetStateResult>(answer),
        "runtime.get_tree" => shaped::<RuntimeGetTreeResult>(answer),
        "runtime.inspect_node" => shaped::<RuntimeInspectNodeResult>(answer),
        "runtime.input" => shaped::<RuntimeInputResult>(answer),
        "runtime.capture" => shaped::<RuntimeCaptureResult>(answer),
        "runtime.get_monitors" => shaped::<RuntimeGetMonitorsResult>(answer),
        "runtime.wait" => shaped::<RuntimeWaitResult>(answer),
        "runtime.pause" => shaped::<RuntimePauseResult>(answer),
        "runtime.resume" => shaped::<RuntimeResumeResult>(answer),
        "godot_session.status" => shaped::<GodotSessionStatusResult>(answer),
        "godot_session.start" => shaped::<GodotSessionStartResult>(answer),
        "godot_session.stop" => shaped::<GodotSessionStopResult>(answer),
        "godot_resource.list" => shaped::<GodotResourceListResult>(answer),
        "godot_resource.move" => shaped::<GodotResourceMoveResult>(answer),
        "godot_resource.delete" => shaped::<GodotResourceDeleteResult>(answer),
        "godot_script.list" => shaped::<GodotScriptListResult>(answer),
        "godot_script.open" => shaped::<GodotScriptOpenResult>(answer),
        "godot_script.update" => shaped::<GodotScriptUpdateResult>(answer),
        "godot_script.edit" => shaped::<GodotScriptEditResult>(answer),
        "godot_script.save" => shaped::<GodotScriptSaveResult>(answer),
        "godot_script.close" => shaped::<GodotScriptCloseResult>(answer),
        "godot_script.format" => shaped::<GodotScriptFormatResult>(answer),
        "godot_script.hover" => shaped::<GodotScriptHoverResult>(answer),
        "godot_script.completion" => shaped::<GodotScriptCompletionResult>(answer),
        "godot_script.signature_help" => shaped::<GodotScriptSignatureHelpResult>(answer),
        "godot_script.definition" => shaped::<GodotScriptDefinitionResult>(answer),
        "godot_script.declaration" => shaped::<GodotScriptDeclarationResult>(answer),
        "godot_script.references" => shaped::<GodotScriptReferencesResult>(answer),
        "godot_script.highlights" => shaped::<GodotScriptHighlightsResult>(answer),
        "godot_script.diagnostics" => shaped::<GodotScriptDiagnosticsResult>(answer),
        "godot_script.document_symbols" => shaped::<GodotScriptDocumentSymbolsResult>(answer),
        "godot_script.workspace_symbols" => shaped::<GodotScriptWorkspaceSymbolsResult>(answer),
        "godot_script.prepare_rename" => shaped::<GodotScriptPrepareRenameResult>(answer),
        "godot_script.rename" => shaped::<GodotScriptRenameResult>(answer),
        "godot_script.apply_rename" => shaped::<GodotScriptApplyRenameResult>(answer),
        "godot_debug.status" => shaped::<GodotDebugStatusResult>(answer),
        "godot_debug.set_breakpoints" => shaped::<GodotDebugSetBreakpointsResult>(answer),
        "godot_debug.breakpoint_locations" => shaped::<GodotDebugBreakpointLocationsResult>(answer),
        "godot_debug.launch" => shaped::<GodotDebugLaunchResult>(answer),
        "godot_debug.attach" => shaped::<GodotDebugAttachResult>(answer),
        "godot_debug.await_stop" => shaped::<GodotDebugAwaitStopResult>(answer),
        "godot_debug.threads" => shaped::<GodotDebugThreadsResult>(answer),
        "godot_debug.stack_trace" => shaped::<GodotDebugStackTraceResult>(answer),
        "godot_debug.scopes" => shaped::<GodotDebugScopesResult>(answer),
        "godot_debug.variables" => shaped::<GodotDebugVariablesResult>(answer),
        "godot_debug.evaluate" => shaped::<GodotDebugEvaluateResult>(answer),
        "godot_debug.continue" => shaped::<GodotDebugContinueResult>(answer),
        "godot_debug.pause" => shaped::<GodotDebugPauseResult>(answer),
        "godot_debug.step_over" => shaped::<GodotDebugStepOverResult>(answer),
        "godot_debug.step_in" => shaped::<GodotDebugStepInResult>(answer),
        "godot_debug.step_out" => shaped::<GodotDebugStepOutResult>(answer),
        "godot_debug.restart" => shaped::<GodotDebugRestartResult>(answer),
        "godot_debug.terminate" => shaped::<GodotDebugTerminateResult>(answer),
        "godot_debug.disconnect" => shaped::<GodotDebugDisconnectResult>(answer),
        "godot_logs.read" => shaped::<GodotLogsReadResult>(answer),
        "godot_docs_search.search" => shaped::<GodotDocsSearchSearchResult>(answer),
        "godot_docs_search.ask" => shaped::<GodotDocsSearchAskResult>(answer),
        other => Err(format!("{other} declares no result shape")),
    }
}
// GENERATED-END results
