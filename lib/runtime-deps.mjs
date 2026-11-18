const xterm = 'node_modules/@xterm/headless';
const nodePty = 'node_modules/node-pty';

const sharedFiles = [
  `${xterm}/package.json`, `${xterm}/lib-headless/xterm-headless.js`,
  `${nodePty}/package.json`, `${nodePty}/LICENSE`,
  'node_modules/node-addon-api/LICENSE.md',
  ...[
    'conpty_console_list_agent', 'eventEmitter2', 'index', 'interfaces', 'shared/conout',
    'terminal', 'types', 'unixTerminal', 'utils', 'windowsConoutConnection',
    'windowsPtyAgent', 'windowsTerminal', 'worker/conoutSocketWorker',
  ].map(name => `${nodePty}/lib/${name}.js`),
];

const nativeFiles = {
  linux: ['pty.node'],
  darwin: ['pty.node', 'spawn-helper'],
  win32: ['conpty.node', 'conpty_console_list.node', 'conpty/conpty.dll', 'conpty/OpenConsole.exe'],
};

function prebuildFiles(platform, arch) {
  return nativeFiles[platform].map(file => `${nodePty}/prebuilds/${platform}-${arch}/${file}`);
}

export const bundledDependencyFiles = [
  ...sharedFiles,
  ...Object.keys(nativeFiles).flatMap(platform => ['x64', 'arm64'].flatMap(arch => prebuildFiles(platform, arch))),
];

export const dependencyLicenses = ['licenses/xterm-headless.txt', 'licenses/windows-terminal.txt'];

export function hostDependencyFiles() {
  const { platform, arch } = process;
  if (!Object.hasOwn(nativeFiles, platform) || !['x64', 'arm64'].includes(arch)) return [];
  return [...sharedFiles, ...prebuildFiles(platform, arch), ...dependencyLicenses];
}
