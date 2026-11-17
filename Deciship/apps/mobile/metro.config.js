const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const coreRoot = path.resolve(projectRoot, '../../packages/core');
// Platform deposu aynı klasörde: SellerOnData/Platform (ARCHITECTURE §2).
const contractsRoot = path.resolve(projectRoot, '../../../Platform/packages/contracts');

const formatRoot = path.resolve(projectRoot, '../../../Platform/packages/format');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [...(config.watchFolders ?? []), coreRoot, contractsRoot, formatRoot];
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, 'node_modules')];
config.resolver.extraNodeModules = {
  ...(config.resolver.extraNodeModules ?? {}),
  '@deciship/core': coreRoot,
  '@sellerondata/contracts': contractsRoot,
  '@sellerondata/format': formatRoot,
};
config.resolver.unstable_enableSymlinks = true;
config.resolver.unstable_enablePackageExports = true;

module.exports = config;
