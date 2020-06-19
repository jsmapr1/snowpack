import chalk from 'chalk';
import {EventEmitter} from 'events';
import execa from 'execa';
import {promises as fs} from 'fs';
import glob from 'glob';
import mkdirp from 'mkdirp';
import npmRunPath from 'npm-run-path';
import path from 'path';
import rimraf from 'rimraf';
import {BuildScript} from '../config';
import {BUILD_DEPENDENCIES_DIR, CommandOptions, ImportMap} from '../util';
import {generateEnvModule} from './build-util';
import {stopEsbuild} from './esbuildPlugin';
import {command as installCommand} from './install';
import {paint} from './paint';

export async function command(commandOptions: CommandOptions) {
  const {cwd, config} = commandOptions;

  // Start with a fresh install of your dependencies, for production
  commandOptions.config.installOptions.env.NODE_ENV = process.env.NODE_ENV || 'production';
  commandOptions.config.installOptions.dest = BUILD_DEPENDENCIES_DIR;
  commandOptions.config.installOptions.treeshake =
    commandOptions.config.installOptions.treeshake !== undefined
      ? commandOptions.config.installOptions.treeshake
      : true;
  const dependencyImportMapLoc = path.join(config.installOptions.dest, 'import-map.json');

  // Start with a fresh install of your dependencies, always.
  console.log(chalk.yellow('! rebuilding dependencies...'));
  await installCommand(commandOptions);

  const messageBus = new EventEmitter();
  const runScripts: BuildScript[] = [];
  const mountScripts: BuildScript[] = [];
  let bundleWorker = config.scripts.find((s) => s.type === 'bundle');
  const allBuildExtensions: string[] = [];

  let dependencyImportMap: ImportMap = {imports: {}};
  try {
    dependencyImportMap = require(dependencyImportMapLoc);
  } catch (err) {
    // no import-map found, safe to ignore
  }

  for (const workerConfig of config.scripts) {
    const {type} = workerConfig;
    if (type === 'run') {
      runScripts.push(workerConfig);
    } else if (type === 'mount') {
      mountScripts.push(workerConfig);
    }
  }

  const isBundledHardcoded = config.devOptions.bundle !== undefined;
  const isBundled = isBundledHardcoded ? !!config.devOptions.bundle : !!bundleWorker;
  if (!bundleWorker) {
    bundleWorker = {id: 'bundle:*', type: 'bundle', match: ['*'], cmd: '', watch: undefined};
  }

  const buildDirectoryLoc = isBundled ? path.join(cwd, `.build`) : config.devOptions.out;
  const internalFilesBuildLoc = path.join(buildDirectoryLoc, config.buildOptions.metaDir);
  const finalDirectoryLoc = config.devOptions.out;

  if (config.scripts.length <= 1) {
    console.error(chalk.red(`No build scripts found, so nothing to build.`));
    console.error(`See https://www.snowpack.dev/#build-scripts for help getting started.`);
    return;
  }

  rimraf.sync(buildDirectoryLoc);
  mkdirp.sync(buildDirectoryLoc);
  mkdirp.sync(internalFilesBuildLoc);
  if (finalDirectoryLoc !== buildDirectoryLoc) {
    rimraf.sync(finalDirectoryLoc);
    mkdirp.sync(finalDirectoryLoc);
  }

  console.log = (...args) => {
    messageBus.emit('CONSOLE', {level: 'log', args});
  };
  console.warn = (...args) => {
    messageBus.emit('CONSOLE', {level: 'warn', args});
  };
  console.error = (...args) => {
    messageBus.emit('CONSOLE', {level: 'error', args});
  };
  let relDest = path.relative(cwd, config.devOptions.out);
  if (!relDest.startsWith(`..${path.sep}`)) {
    relDest = `.${path.sep}` + relDest;
  }
  paint(messageBus, [...mountScripts, ...runScripts, bundleWorker], {dest: relDest}, undefined);

  if (!isBundled) {
    messageBus.emit('WORKER_UPDATE', {
      id: bundleWorker.id,
      state: ['SKIP', 'dim'],
    });
  }

  // handle run:* cripts
  for (const workerConfig of runScripts) {
    const {id} = workerConfig;
    messageBus.emit('WORKER_UPDATE', {id, state: ['RUNNING', 'yellow']});
    const workerPromise = execa.command(workerConfig.cmd, {
      env: npmRunPath.env(),
      extendEnv: true,
      shell: true,
      cwd,
    });
    workerPromise.catch((err) => {
      messageBus.emit('WORKER_MSG', {id, level: 'error', msg: err.toString()});
      messageBus.emit('WORKER_COMPLETE', {id, error: err});
    });
    workerPromise.then(() => {
      messageBus.emit('WORKER_COMPLETE', {id, error: null});
    });
    const {stdout, stderr} = workerPromise;
    stdout?.on('data', (b) => {
      let stdOutput = b.toString();
      if (stdOutput.includes('\u001bc') || stdOutput.includes('\x1Bc')) {
        messageBus.emit('WORKER_RESET', {id});
        stdOutput = stdOutput.replace(/\x1Bc/, '').replace(/\u001bc/, '');
      }
      if (id.endsWith(':tsc')) {
        if (stdOutput.includes('\u001bc') || stdOutput.includes('\x1Bc')) {
          messageBus.emit('WORKER_UPDATE', {id, state: ['RUNNING', 'yellow']});
        }
        if (/Watching for file changes./gm.test(stdOutput)) {
          messageBus.emit('WORKER_UPDATE', {id, state: 'WATCHING'});
        }
        const errorMatch = stdOutput.match(/Found (\d+) error/);
        if (errorMatch && errorMatch[1] !== '0') {
          messageBus.emit('WORKER_UPDATE', {id, state: ['ERROR', 'red']});
        }
      }
      messageBus.emit('WORKER_MSG', {id, level: 'log', msg: stdOutput});
    });
    stderr?.on('data', (b) => {
      messageBus.emit('WORKER_MSG', {id, level: 'error', msg: b.toString()});
    });
    await workerPromise;
  }

  // Write the `import.meta.env` contents file to disk
  await fs.writeFile(path.join(internalFilesBuildLoc, 'env.js'), generateEnvModule('production'));

  // handle mount:* scripts
  const mountDirDetails: any[] = mountScripts.map((scriptConfig) => {
    const {id, type, args} = scriptConfig;
    if (type !== 'mount') {
      return false;
    }
    const dirDisk = path.resolve(cwd, args.fromDisk);
    const dirDest = path.resolve(buildDirectoryLoc, args.toUrl.replace(/^\//, ''));
    return [id, dirDisk, dirDest];
  });
  const includeFileSets: [string, string, string[]][] = [];
  for (const [id, dirDisk, dirDest] of mountDirDetails) {
    messageBus.emit('WORKER_UPDATE', {id, state: ['RUNNING', 'yellow']});
    let allFiles;
    try {
      allFiles = glob.sync(`**/*`, {
        ignore: id === 'mount:web_modules' ? [] : config.exclude,
        cwd: dirDisk,
        absolute: true,
        nodir: true,
        dot: true,
      });
      const allBuildNeededFiles: string[] = [];
      await Promise.all(
        allFiles.map(async (f) => {
          f = path.resolve(f); // this is necessary since glob.sync() returns paths with / on windows.  path.resolve() will switch them to the native path separator.
          if (
            !f.startsWith(commandOptions.config.installOptions.dest) &&
            (allBuildExtensions.includes(path.extname(f).substr(1)) ||
              path.extname(f) === '.jsx' ||
              path.extname(f) === '.tsx' ||
              path.extname(f) === '.ts' ||
              path.extname(f) === '.js')
          ) {
            allBuildNeededFiles.push(f);
            return;
          }
          const outPath = f.replace(dirDisk, dirDest);
          mkdirp.sync(path.dirname(outPath));

          // replace %PUBLIC_URL% in HTML files
          if (path.extname(f) === '.html') {
            let code = await fs.readFile(f, 'utf8');
            code = code.replace(/%PUBLIC_URL%\/?/g, config.buildOptions.baseUrl);
            return fs.writeFile(outPath, code, 'utf8');
          }
          return fs.copyFile(f, outPath);
        }),
      );
      includeFileSets.push([dirDisk, dirDest, allBuildNeededFiles]);
      messageBus.emit('WORKER_COMPLETE', {id});
    } catch (err) {
      messageBus.emit('WORKER_MSG', {id, level: 'error', msg: err.toString()});
      messageBus.emit('WORKER_COMPLETE', {id, error: err});
    }
  }

  const allBuiltFromFiles = new Set<string>();

  // TODO: handle pipeline

  stopEsbuild();

  if (!isBundled) {
    messageBus.emit('WORKER_COMPLETE', {id: bundleWorker.id, error: null});
    messageBus.emit('WORKER_UPDATE', {
      id: bundleWorker.id,
      state: ['SKIP', isBundledHardcoded ? 'dim' : 'yellow'],
    });
    if (!isBundledHardcoded) {
      messageBus.emit('WORKER_MSG', {
        id: bundleWorker.id,
        level: 'log',
        msg:
          `"plugins": ["@snowpack/plugin-webpack"]\n\n` +
          `Connect a bundler plugin to optimize your build for production.\n` +
          chalk.dim(`Set "devOptions.bundle" configuration to false to remove this message.`),
      });
    }
  } else {
    try {
      messageBus.emit('WORKER_UPDATE', {id: bundleWorker.id, state: ['RUNNING', 'yellow']});
      await bundleWorker?.plugin!.bundle!({
        srcDirectory: buildDirectoryLoc,
        destDirectory: finalDirectoryLoc,
        jsFilePaths: allBuiltFromFiles,
        log: (msg) => {
          messageBus.emit('WORKER_MSG', {id: bundleWorker!.id, level: 'log', msg});
        },
      });
      messageBus.emit('WORKER_COMPLETE', {id: bundleWorker.id, error: null});
    } catch (err) {
      messageBus.emit('WORKER_MSG', {
        id: bundleWorker.id,
        level: 'error',
        msg: err.toString(),
      });
      messageBus.emit('WORKER_COMPLETE', {id: bundleWorker.id, error: err});
    }
  }

  if (finalDirectoryLoc !== buildDirectoryLoc) {
    rimraf.sync(buildDirectoryLoc);
  }
}
