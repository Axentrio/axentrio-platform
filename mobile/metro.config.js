// Metro config: NativeWind + npm-workspace (monorepo) resolution.
const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '..');

const config = getDefaultConfig(projectRoot);

// Watch the workspace so Metro can transform @axentrio/* source in packages/.
config.watchFolders = [workspaceRoot];
// Resolve hoisted deps from the root node_modules as well as the app's own.
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

module.exports = withNativeWind(config, { input: './src/global.css' });
