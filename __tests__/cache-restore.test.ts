import * as path from 'path';
import {fileURLToPath} from 'url';
import {jest} from '@jest/globals';
import osm from 'os';

type SpyInstance = jest.SpiedFunction<(...args: any[]) => any>;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

jest.unstable_mockModule('@actions/core', () => ({
  ...(jest.requireActual('@actions/core') as any),
  info: jest.fn(),
  debug: jest.fn(),
  setOutput: jest.fn(),
  saveState: jest.fn()
}));

jest.unstable_mockModule('@actions/cache', () => ({
  ...(jest.requireActual('@actions/cache') as any),
  restoreCache: jest.fn()
}));

jest.unstable_mockModule('@actions/glob', () => ({
  ...(jest.requireActual('@actions/glob') as any),
  hashFiles: jest.fn()
}));

jest.unstable_mockModule('../src/cache-utils.js', () => ({
  ...(jest.requireActual('../src/cache-utils.js') as any),
  getCommandOutput: jest.fn()
}));

const core = await import('@actions/core');
const cache = await import('@actions/cache');
const glob = await import('@actions/glob');
const utils = await import('../src/cache-utils.js');
const {restoreCache} = await import('../src/cache-restore.js');

describe('cache-restore', () => {
  const packageManagers = ['yarn', 'npm', 'pnpm'] as const;
  type PackageManager = (typeof packageManagers)[number];

  const setWorkspaceFor = (pm: PackageManager) => {
    process.env['GITHUB_WORKSPACE'] = path.join(__dirname, 'data', pm);
  };
  const originalGithubWorkspace = process.env['GITHUB_WORKSPACE'];
  if (!process.env.RUNNER_OS) {
    process.env.RUNNER_OS = 'Linux';
  }
  const platform = process.env.RUNNER_OS;
  const arch = 'arm64';
  const commonPath = '/some/random/path';
  const npmCachePath = `${commonPath}/npm`;
  const pnpmCachePath = `${commonPath}/pnpm`;
  const yarn1CachePath = `${commonPath}/yarn1`;
  const yarn2CachePath = `${commonPath}/yarn2`;
  const yarnFileHash =
    'b8a0bae5243251f7c07dd52d1f78ff78281dfefaded700a176261b6b54fa245b';
  const npmFileHash =
    'abf7c9b306a3149dcfba4673e2362755503bcceaab46f0e4e6fee0ade493e20c';
  const pnpmFileHash =
    '26309058093e84713f38869c50cf1cee9b08155ede874ec1b44ce3fca8c68c70';
  const cachesObject: Record<string, string> = {
    [npmCachePath]: npmFileHash,
    [pnpmCachePath]: pnpmFileHash,
    [yarn1CachePath]: yarnFileHash,
    [yarn2CachePath]: yarnFileHash
  };

  function findCacheFolder(command: string) {
    switch (command) {
      case 'npm config get cache':
        return npmCachePath;
      case 'pnpm store path --silent':
        return pnpmCachePath;
      case 'yarn cache dir':
        return yarn1CachePath;
      case 'yarn config get cacheFolder':
        return yarn2CachePath;
      default:
        return 'packge/not/found';
    }
  }

  let saveStateSpy: SpyInstance;
  let infoSpy: SpyInstance;
  let debugSpy: SpyInstance;
  let setOutputSpy: SpyInstance;
  let getCommandOutputSpy: SpyInstance;
  let restoreCacheSpy: SpyInstance;
  let hashFilesSpy: SpyInstance;
  let archSpy: SpyInstance;

  beforeEach(() => {
    // core
    infoSpy = core.info as unknown as SpyInstance;
    infoSpy.mockImplementation(() => undefined);

    debugSpy = core.debug as unknown as SpyInstance;
    debugSpy.mockImplementation(() => undefined);

    setOutputSpy = core.setOutput as unknown as SpyInstance;
    setOutputSpy.mockImplementation(() => undefined);

    saveStateSpy = core.saveState as unknown as SpyInstance;
    saveStateSpy.mockImplementation(() => undefined);

    // glob
    hashFilesSpy = glob.hashFiles as unknown as SpyInstance;
    hashFilesSpy.mockImplementation((pattern: string) => {
      if (pattern.includes('package-lock.json')) {
        return npmFileHash;
      } else if (pattern.includes('pnpm-lock.yaml')) {
        return pnpmFileHash;
      } else if (pattern.includes('yarn.lock')) {
        return yarnFileHash;
      } else {
        return '';
      }
    });

    // cache
    restoreCacheSpy = cache.restoreCache as unknown as SpyInstance;
    restoreCacheSpy.mockImplementation(
      (cachePaths: Array<string>, key: string) => {
        if (!cachePaths || cachePaths.length === 0) {
          return undefined;
        }

        const cachPath = cachePaths[0];
        const fileHash = cachesObject[cachPath];

        if (key.includes(fileHash)) {
          return key;
        }

        return undefined;
      }
    );

    // cache-utils
    getCommandOutputSpy = utils.getCommandOutput as unknown as SpyInstance;

    // os
    archSpy = jest.spyOn(osm, 'arch');
    archSpy.mockImplementation(() => arch);
  });

  describe('Validate provided package manager', () => {
    it.each([['npm7'], ['npm6'], ['pnpm6'], ['yarn1'], ['yarn2'], ['random']])(
      'Throw an error because %s is not supported',
      async packageManager => {
        await expect(restoreCache(packageManager, '')).rejects.toThrow(
          `Caching for '${packageManager}' is not supported`
        );
      }
    );
  });

  describe('Restore dependencies', () => {
    it.each([
      ['yarn', '2.1.2', yarnFileHash],
      ['yarn', '1.2.3', yarnFileHash],
      ['npm', '', npmFileHash],
      ['pnpm', '', pnpmFileHash]
    ] as const)(
      'restored dependencies for %s',
      async (packageManager, toolVersion, fileHash) => {
        // Set workspace to the appropriate fixture folder
        setWorkspaceFor(packageManager);
        getCommandOutputSpy.mockImplementation((command: string) => {
          if (command.includes('version')) {
            return toolVersion;
          } else {
            return findCacheFolder(command);
          }
        });

        await restoreCache(packageManager, '');
        expect(hashFilesSpy).toHaveBeenCalled();
        expect(infoSpy).toHaveBeenCalledWith(
          `Cache restored from key: node-cache-${platform}-${arch}-${packageManager}-${fileHash}`
        );
        expect(infoSpy).not.toHaveBeenCalledWith(
          `${packageManager} cache is not found`
        );
        expect(setOutputSpy).toHaveBeenCalledWith('cache-hit', true);
      }
    );
  });

  describe('Dependencies changed', () => {
    it.each([
      ['yarn', '2.1.2', yarnFileHash],
      ['yarn', '1.2.3', yarnFileHash],
      ['npm', '', npmFileHash],
      ['pnpm', '', pnpmFileHash]
    ] as const)(
      'dependencies are changed %s',
      async (packageManager, toolVersion, fileHash) => {
        // Set workspace to the appropriate fixture folder
        setWorkspaceFor(packageManager);
        getCommandOutputSpy.mockImplementation((command: string) => {
          if (command.includes('version')) {
            return toolVersion;
          } else {
            return findCacheFolder(command);
          }
        });

        restoreCacheSpy.mockImplementationOnce(() => undefined);
        await restoreCache(packageManager, '');
        expect(hashFilesSpy).toHaveBeenCalled();
        expect(infoSpy).toHaveBeenCalledWith(
          `${packageManager} cache is not found`
        );
        expect(setOutputSpy).toHaveBeenCalledWith('cache-hit', false);
      }
    );
  });

  afterEach(() => {
    if (originalGithubWorkspace === undefined) {
      delete process.env['GITHUB_WORKSPACE'];
    } else {
      process.env['GITHUB_WORKSPACE'] = originalGithubWorkspace;
    }
    jest.resetAllMocks();
    jest.clearAllMocks();
  });
});
