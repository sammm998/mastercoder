// Expo's default Metro config detects the pnpm workspace (watch folders + node_modules lookup) automatically.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getDefaultConfig } = require("expo/metro-config");

module.exports = getDefaultConfig(__dirname);
