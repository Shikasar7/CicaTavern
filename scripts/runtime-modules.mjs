// What the server needs from node_modules at run time: YAML and the QuickJS
// sandbox for EJS. Not the Agent SDK or Claude Code (subscription only).
// Shared by the Android staging (android/scripts/stage-node.mjs) and the
// desktop release (scripts/stage-release.mjs).
export const RUNTIME_MODULES = [
  'yaml',
  'quickjs-emscripten',
  'quickjs-emscripten-core',
  '@jitl/quickjs-ffi-types',
  '@jitl/quickjs-wasmfile-release-sync',
  '@jitl/quickjs-wasmfile-release-asyncify',
  '@jitl/quickjs-wasmfile-debug-sync',
  '@jitl/quickjs-wasmfile-debug-asyncify',
]
