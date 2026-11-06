export { applyVisualEdit, describeElement, cssPropToJs, type VisualEdit, type ElementInfo, type ApplyOptions } from "./apply.js";
export { VisualEditError, parseSource, findElementAt } from "./ast.js";
export { tagJsxSource, relativePath, type TagResult } from "./tag.js";
// Named (not `export *`) so every bundler, including Turbopack, sees the re-exports statically.
export {
  SRC_ATTR,
  PROTOCOL_VERSION,
  parseSrc,
  formatSrc,
  isSelectMessage,
  isReadyMessage,
  isInspectorMessage,
  isParentMessage,
  selectorForSrc,
  srcFromSelector,
  type SourcePosition,
  type SourceLocation,
  type InspectedStyles,
  type ForgeSelectMessage,
  type ForgeReadyMessage,
  type InspectorToParent,
  type ForgeHighlightMessage,
  type ForgeInspectMessage,
  type ParentToInspector,
} from "./protocol.js";
export { INSPECTOR_SCRIPT } from "./inspector-script.js";
export * from "./project-setup.js";
export { VISUAL_EDIT_PLUGIN_SOURCE } from "./plugin-bundle.js";
