/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra
*/

"use strict";

const asyncLib = require("neo-async");
const {
	HookMap,
	SyncHook,
	SyncBailHook,
	SyncWaterfallHook,
	AsyncSeriesHook
} = require("tapable");
const util = require("util");
const { CachedSource } = require("webpack-sources");
const Chunk = require("./Chunk");
const ChunkGraph = require("./ChunkGraph");
const ChunkGroup = require("./ChunkGroup");
const ChunkRenderError = require("./ChunkRenderError");
const ChunkTemplate = require("./ChunkTemplate");
const CodeGenerationError = require("./CodeGenerationError");
const DependencyTemplates = require("./DependencyTemplates");
const Entrypoint = require("./Entrypoint");
const ErrorHelpers = require("./ErrorHelpers");
const FileSystemInfo = require("./FileSystemInfo");
const { connectChunkGroupAndChunk } = require("./GraphHelpers");
const { makeWebpackError } = require("./HookWebpackError");
const MainTemplate = require("./MainTemplate");
const Module = require("./Module");
const ModuleDependencyError = require("./ModuleDependencyError");
const ModuleDependencyWarning = require("./ModuleDependencyWarning");
const ModuleGraph = require("./ModuleGraph");
const ModuleNotFoundError = require("./ModuleNotFoundError");
const ModuleProfile = require("./ModuleProfile");
const ModuleRestoreError = require("./ModuleRestoreError");
const ModuleTemplate = require("./ModuleTemplate");
const RuntimeGlobals = require("./RuntimeGlobals");
const RuntimeTemplate = require("./RuntimeTemplate");
const Stats = require("./Stats");
const WebpackError = require("./WebpackError");
const buildChunkGraph = require("./buildChunkGraph");
const { Logger, LogType } = require("./logging/Logger");
const StatsFactory = require("./stats/StatsFactory");
const StatsPrinter = require("./stats/StatsPrinter");
const AsyncQueue = require("./util/AsyncQueue");
const LazySet = require("./util/LazySet");
const {
	compareLocations,
	concatComparators,
	compareSelect,
	compareIds,
	compareStringsNumeric,
	compareModulesByIdentifier
} = require("./util/comparators");
const createHash = require("./util/createHash");
const { arrayToSetDeprecation } = require("./util/deprecation");

/** @typedef {import("webpack-sources").Source} Source */
/** @typedef {import("../declarations/WebpackOptions").OutputOptions} OutputOptions */
/** @typedef {import("./AsyncDependenciesBlock")} AsyncDependenciesBlock */
/** @typedef {import("./ChunkGroup").ChunkGroupOptions} ChunkGroupOptions */
/** @typedef {import("./Compiler")} Compiler */
/** @typedef {import("./DependenciesBlock")} DependenciesBlock */
/** @typedef {import("./Dependency")} Dependency */
/** @typedef {import("./Dependency").DependencyLocation} DependencyLocation */
/** @typedef {import("./DependencyTemplate")} DependencyTemplate */
/** @typedef {import("./Module")} Module */
/** @typedef {import("./Module").CodeGenerationResult} CodeGenerationResult */
/** @typedef {import("./ModuleFactory")} ModuleFactory */
/** @typedef {import("./RuntimeModule")} RuntimeModule */
/** @typedef {import("./Template").RenderManifestEntry} RenderManifestEntry */
/** @typedef {import("./Template").RenderManifestOptions} RenderManifestOptions */
/** @typedef {import("./WebpackError")} WebpackError */
/** @typedef {import("./dependencies/DllEntryDependency")} DllEntryDependency */
/** @typedef {import("./dependencies/EntryDependency")} EntryDependency */
/** @typedef {import("./stats/StatsFactory")} StatsFactory */
/** @typedef {import("./stats/StatsPrinter")} StatsPrinter */
/** @typedef {import("./util/Hash")} Hash */

/**
 * @callback Callback
 * @param {WebpackError=} err
 * @returns {void}
 */

/**
 * @callback ModuleCallback
 * @param {WebpackError=} err
 * @param {Module=} result
 * @returns {void}
 */

/**
 * @callback DepBlockVarDependenciesCallback
 * @param {Dependency} dependency
 * @returns {any}
 */

/**
 * @typedef {Object} Plugin
 * @property {() => void} apply
 */

/** @typedef {new (...args: any[]) => Dependency} DepConstructor */
/** @typedef {Record<string, Source>} CompilationAssets */

/**
 * @typedef {Object} AvailableModulesChunkGroupMapping
 * @property {ChunkGroup} chunkGroup
 * @property {Set<Module>} availableModules
 * @property {boolean} needCopy
 */

/**
 * @typedef {Object} DependenciesBlockLike
 * @property {Dependency[]} dependencies
 * @property {AsyncDependenciesBlock[]} blocks
 */

/**
 * @typedef {Object} ChunkPathData
 * @property {string|number} id
 * @property {string=} name
 * @property {string} hash
 * @property {function(number): string=} hashWithLength
 * @property {(Record<string, string>)=} contentHash
 * @property {(Record<string, (length: number) => string>)=} contentHashWithLength
 */

/**
 * @typedef {Object} ChunkHashContext
 * @property {RuntimeTemplate} runtimeTemplate the runtime template
 * @property {ModuleGraph} moduleGraph the module graph
 * @property {ChunkGraph} chunkGraph the chunk graph
 */

/**
 * @typedef {Object} LogEntry
 * @property {string} type
 * @property {any[]} args
 * @property {number} time
 * @property {string[]=} trace
 */

/**
 * @typedef {Object} AssetInfo
 * @property {boolean=} immutable true, if the asset can be long term cached forever (contains a hash)
 * @property {number=} size size in bytes, only set after asset has been emitted
 * @property {boolean=} development true, when asset is only used for development and doesn't count towards user-facing assets
 * @property {boolean=} hotModuleReplacement true, when asset ships data for updating an existing application (HMR)
 */

/**
 * @typedef {Object} Asset
 * @property {string} name the filename of the asset
 * @property {Source} source source of the asset
 * @property {AssetInfo} info info about the asset
 */

/**
 * @typedef {Object} ModulePathData
 * @property {string|number} id
 * @property {string} hash
 * @property {function(number): string=} hashWithLength
 */

/**
 * @typedef {Object} PathData
 * @property {ChunkGraph=} chunkGraph
 * @property {string=} hash
 * @property {function(number): string=} hashWithLength
 * @property {(Chunk|ChunkPathData)=} chunk
 * @property {(Module|ModulePathData)=} module
 * @property {string=} filename
 * @property {string=} basename
 * @property {string=} query
 * @property {string=} contentHashType
 * @property {string=} contentHash
 * @property {function(number): string=} contentHashWithLength
 * @property {boolean=} noChunkHash
 * @property {string=} url
 */

// TODO webpack 6: remove
const deprecatedNormalModuleLoaderHook = util.deprecate(compilation => {
	return require("./NormalModule").getCompilationHooks(compilation).loader;
}, "Compilation.hooks.normalModuleLoader was moved to NormalModule.getCompilationHooks(compilation).loader");

const byId = compareSelect(
	/**
	 * @param {Chunk} c chunk
	 * @returns {number | string} id
	 */ c => c.id,
	compareIds
);

const byNameOrHash = concatComparators(
	compareSelect(
		/**
		 * @param {Compilation} c compilation
		 * @returns {string} name
		 */
		c => c.name,
		compareIds
	),
	compareSelect(
		/**
		 * @param {Compilation} c compilation
		 * @returns {string} hash
		 */ c => c.fullHash,
		compareIds
	)
);

const byMessage = compareSelect(err => `${err.message}`, compareStringsNumeric);

const byModule = compareSelect(
	err => (err.module && err.module.identifier()) || "",
	compareStringsNumeric
);

const byLocation = compareSelect(err => err.loc, compareLocations);

const compareErrors = concatComparators(byModule, byLocation, byMessage);

/**
 * @param {Source} a a source
 * @param {Source} b another source
 * @returns {boolean} true, when both sources are equal
 */
const isSourceEqual = (a, b) => {
	if (a === b) return true;
	// TODO webpack 5: check .buffer() instead, it's called anyway during emit
	/** @type {Buffer|string} */
	let aSource = a.source();
	/** @type {Buffer|string} */
	let bSource = b.source();
	if (aSource === bSource) return true;
	if (typeof aSource === "string" && typeof bSource === "string") return false;
	if (!Buffer.isBuffer(aSource)) aSource = Buffer.from(aSource, "utf-8");
	if (!Buffer.isBuffer(bSource)) bSource = Buffer.from(bSource, "utf-8");
	return aSource.equals(bSource);
};

class Compilation {
	/**
	 * Creates an instance of Compilation.
	 * @param {Compiler} compiler the compiler which created the compilation
	 */
	constructor(compiler) {
		const getNormalModuleLoader = () => deprecatedNormalModuleLoaderHook(this);
		this.hooks = Object.freeze({
			/** @type {SyncHook<[Module]>} */
			buildModule: new SyncHook(["module"]),
			/** @type {SyncHook<[Module]>} */
			rebuildModule: new SyncHook(["module"]),
			/** @type {SyncHook<[Module, WebpackError]>} */
			failedModule: new SyncHook(["module", "error"]),
			/** @type {SyncHook<[Module]>} */
			succeedModule: new SyncHook(["module"]),
			/** @type {SyncHook<[Module]>} */
			stillValidModule: new SyncHook(["module"]),

			/** @type {SyncHook<[Dependency, string]>} */
			addEntry: new SyncHook(["entry", "name"]),
			/** @type {SyncHook<[Dependency, string, Error]>} */
			failedEntry: new SyncHook(["entry", "name", "error"]),
			/** @type {SyncHook<[Dependency, string, Module]>} */
			succeedEntry: new SyncHook(["entry", "name", "module"]),

			/** @type {SyncWaterfallHook<[string[][], Dependency]>} */
			dependencyReferencedExports: new SyncWaterfallHook([
				"referencedExports",
				"dependency"
			]),

			/** @type {AsyncSeriesHook<[Iterable<Module>]>} */
			finishModules: new AsyncSeriesHook(["modules"]),
			/** @type {AsyncSeriesHook<[Module]>} */
			finishRebuildingModule: new AsyncSeriesHook(["module"]),
			/** @type {SyncHook<[]>} */
			unseal: new SyncHook([]),
			/** @type {SyncHook<[]>} */
			seal: new SyncHook([]),

			/** @type {SyncHook<[]>} */
			beforeChunks: new SyncHook([]),
			/** @type {SyncHook<[Iterable<Chunk>]>} */
			afterChunks: new SyncHook(["chunks"]),

			/** @type {SyncBailHook<[Iterable<Module>]>} */
			optimizeDependencies: new SyncBailHook(["modules"]),
			/** @type {SyncHook<[Iterable<Module>]>} */
			afterOptimizeDependencies: new SyncHook(["modules"]),

			/** @type {SyncHook<[]>} */
			optimize: new SyncHook([]),
			/** @type {SyncBailHook<[Iterable<Module>]>} */
			optimizeModules: new SyncBailHook(["modules"]),
			/** @type {SyncHook<[Iterable<Module>]>} */
			afterOptimizeModules: new SyncHook(["modules"]),

			/** @type {SyncBailHook<[Iterable<Chunk>, ChunkGroup[]]>} */
			optimizeChunks: new SyncBailHook(["chunks", "chunkGroups"]),
			/** @type {SyncHook<[Iterable<Chunk>, ChunkGroup[]]>} */
			afterOptimizeChunks: new SyncHook(["chunks", "chunkGroups"]),

			/** @type {AsyncSeriesHook<[Iterable<Chunk>, Iterable<Module>]>} */
			optimizeTree: new AsyncSeriesHook(["chunks", "modules"]),
			/** @type {SyncHook<[Iterable<Chunk>, Iterable<Module>]>} */
			afterOptimizeTree: new SyncHook(["chunks", "modules"]),

			/** @type {SyncBailHook<[Iterable<Chunk>, Iterable<Module>]>} */
			optimizeChunkModules: new SyncBailHook(["chunks", "modules"]),
			/** @type {SyncHook<[Iterable<Chunk>, Iterable<Module>]>} */
			afterOptimizeChunkModules: new SyncHook(["chunks", "modules"]),
			/** @type {SyncBailHook<[], boolean>} */
			shouldRecord: new SyncBailHook([]),

			/** @type {SyncHook<[Chunk, Set<string>]>} */
			additionalChunkRuntimeRequirements: new SyncHook([
				"chunk",
				"runtimeRequirements"
			]),
			/** @type {HookMap<SyncBailHook<[Chunk, Set<string>]>>} */
			runtimeRequirementInChunk: new HookMap(
				() => new SyncBailHook(["chunk", "runtimeRequirements"])
			),
			/** @type {SyncHook<[Module, Set<string>]>} */
			additionalModuleRuntimeRequirements: new SyncHook([
				"module",
				"runtimeRequirements"
			]),
			/** @type {HookMap<SyncBailHook<[Module, Set<string>]>>} */
			runtimeRequirementInModule: new HookMap(
				() => new SyncBailHook(["module", "runtimeRequirements"])
			),
			/** @type {SyncHook<[Chunk, Set<string>]>} */
			additionalTreeRuntimeRequirements: new SyncHook([
				"chunk",
				"runtimeRequirements"
			]),
			/** @type {HookMap<SyncBailHook<[Chunk, Set<string>]>>} */
			runtimeRequirementInTree: new HookMap(
				() => new SyncBailHook(["chunk", "runtimeRequirements"])
			),

			/** @type {SyncHook<[RuntimeModule, Chunk]>} */
			runtimeModule: new SyncHook(["module", "chunk"]),

			/** @type {SyncHook<[Iterable<Module>, any]>} */
			reviveModules: new SyncHook(["modules", "records"]),
			/** @type {SyncHook<[Iterable<Module>]>} */
			beforeModuleIds: new SyncHook(["modules"]),
			/** @type {SyncHook<[Iterable<Module>]>} */
			moduleIds: new SyncHook(["modules"]),
			/** @type {SyncHook<[Iterable<Module>]>} */
			optimizeModuleIds: new SyncHook(["modules"]),
			/** @type {SyncHook<[Iterable<Module>]>} */
			afterOptimizeModuleIds: new SyncHook(["modules"]),

			/** @type {SyncHook<[Iterable<Chunk>, any]>} */
			reviveChunks: new SyncHook(["chunks", "records"]),
			/** @type {SyncHook<[Iterable<Chunk>]>} */
			beforeChunkIds: new SyncHook(["chunks"]),
			/** @type {SyncHook<[Iterable<Chunk>]>} */
			chunkIds: new SyncHook(["chunks"]),
			/** @type {SyncHook<[Iterable<Chunk>]>} */
			optimizeChunkIds: new SyncHook(["chunks"]),
			/** @type {SyncHook<[Iterable<Chunk>]>} */
			afterOptimizeChunkIds: new SyncHook(["chunks"]),

			/** @type {SyncHook<[Iterable<Module>, any]>} */
			recordModules: new SyncHook(["modules", "records"]),
			/** @type {SyncHook<[Iterable<Chunk>, any]>} */
			recordChunks: new SyncHook(["chunks", "records"]),

			/** @type {SyncHook<[Iterable<Module>]>} */
			optimizeCodeGeneration: new SyncHook(["modules"]),

			/** @type {SyncHook<[]>} */
			beforeModuleHash: new SyncHook([]),
			/** @type {SyncHook<[]>} */
			afterModuleHash: new SyncHook([]),

			/** @type {SyncHook<[]>} */
			beforeCodeGeneration: new SyncHook([]),
			/** @type {SyncHook<[]>} */
			afterCodeGeneration: new SyncHook([]),

			/** @type {SyncHook<[]>} */
			beforeRuntimeRequirements: new SyncHook([]),
			/** @type {SyncHook<[]>} */
			afterRuntimeRequirements: new SyncHook([]),

			/** @type {SyncHook<[]>} */
			beforeHash: new SyncHook([]),
			/** @type {SyncHook<[Chunk]>} */
			contentHash: new SyncHook(["chunk"]),
			/** @type {SyncHook<[]>} */
			afterHash: new SyncHook([]),
			/** @type {SyncHook<[any]>} */
			recordHash: new SyncHook(["records"]),
			/** @type {SyncHook<[Compilation, any]>} */
			record: new SyncHook(["compilation", "records"]),

			/** @type {SyncHook<[]>} */
			beforeModuleAssets: new SyncHook([]),
			/** @type {SyncBailHook<[], boolean>} */
			shouldGenerateChunkAssets: new SyncBailHook([]),
			/** @type {SyncHook<[]>} */
			beforeChunkAssets: new SyncHook([]),
			/** @type {SyncHook<[Iterable<Chunk>]>} */
			additionalChunkAssets: new SyncHook(["chunks"]),

			/** @type {AsyncSeriesHook<[]>} */
			additionalAssets: new AsyncSeriesHook([]),
			/** @type {AsyncSeriesHook<[Iterable<Chunk>]>} */
			optimizeChunkAssets: new AsyncSeriesHook(["chunks"]),
			/** @type {SyncHook<[Iterable<Chunk>]>} */
			afterOptimizeChunkAssets: new SyncHook(["chunks"]),
			/** @type {AsyncSeriesHook<[CompilationAssets]>} */
			optimizeAssets: new AsyncSeriesHook(["assets"]),
			/** @type {SyncHook<[CompilationAssets]>} */
			afterOptimizeAssets: new SyncHook(["assets"]),

			/** @type {SyncBailHook<[], boolean>} */
			needAdditionalSeal: new SyncBailHook([]),
			/** @type {AsyncSeriesHook<[]>} */
			afterSeal: new AsyncSeriesHook([]),

			/** @type {SyncWaterfallHook<[RenderManifestEntry[], RenderManifestOptions]>} */
			renderManifest: new SyncWaterfallHook(["result", "options"]),

			/** @type {SyncHook<[Hash]>} */
			fullHash: new SyncHook(["hash"]),
			/** @type {SyncHook<[Chunk, Hash, ChunkHashContext]>} */
			chunkHash: new SyncHook(["chunk", "chunkHash", "ChunkHashContext"]),

			/** @type {SyncHook<[Module, string]>} */
			moduleAsset: new SyncHook(["module", "filename"]),
			/** @type {SyncHook<[Chunk, string]>} */
			chunkAsset: new SyncHook(["chunk", "filename"]),

			/** @type {SyncWaterfallHook<[string, object, AssetInfo]>} */
			assetPath: new SyncWaterfallHook(["path", "options", "assetInfo"]),

			/** @type {SyncBailHook<[], boolean>} */
			needAdditionalPass: new SyncBailHook([]),

			/** @type {SyncHook<[Compiler, string, number]>} */
			childCompiler: new SyncHook([
				"childCompiler",
				"compilerName",
				"compilerIndex"
			]),

			/** @type {SyncBailHook<[string, LogEntry], true>} */
			log: new SyncBailHook(["origin", "logEntry"]),

			/** @type {HookMap<SyncHook<[Object, Object]>>} */
			statsPreset: new HookMap(() => new SyncHook(["options", "context"])),
			/** @type {SyncHook<[Object, Object]>} */
			statsNormalize: new SyncHook(["options", "context"]),
			/** @type {SyncHook<[StatsFactory, Object]>} */
			statsFactory: new SyncHook(["statsFactory", "options"]),
			/** @type {SyncHook<[StatsPrinter, Object]>} */
			statsPrinter: new SyncHook(["statsPrinter", "options"]),

			get normalModuleLoader() {
				return getNormalModuleLoader();
			}
		});
		/** @type {string=} */
		this.name = undefined;
		/** @type {Compiler} */
		this.compiler = compiler;
		this.resolverFactory = compiler.resolverFactory;
		this.inputFileSystem = compiler.inputFileSystem;
		this.fileSystemInfo = new FileSystemInfo(this.inputFileSystem, {
			managedPaths: compiler.managedPaths,
			immutablePaths: compiler.immutablePaths
		});
		if (compiler.fileTimestamps) {
			this.fileSystemInfo.addFileTimestamps(compiler.fileTimestamps);
		}
		if (compiler.contextTimestamps) {
			this.fileSystemInfo.addContextTimestamps(compiler.contextTimestamps);
		}
		this.requestShortener = compiler.requestShortener;
		this.compilerPath = compiler.compilerPath;
		this.cache = compiler.cache;

		const options = compiler.options;
		this.options = options;
		this.outputOptions = options && options.output;
		/** @type {boolean} */
		this.bail = (options && options.bail) || false;
		/** @type {boolean} */
		this.profile = (options && options.profile) || false;

		this.mainTemplate = new MainTemplate(this.outputOptions, this);
		this.chunkTemplate = new ChunkTemplate(this.outputOptions, this);
		this.runtimeTemplate = new RuntimeTemplate(
			this.outputOptions,
			this.requestShortener
		);
		/** @type {{javascript: ModuleTemplate}} */
		this.moduleTemplates = {
			javascript: new ModuleTemplate(this.runtimeTemplate, this)
		};
		Object.defineProperties(this.moduleTemplates, {
			asset: {
				enumerable: false,
				configurable: false,
				get() {
					throw new WebpackError(
						"Compilation.moduleTemplates.asset has been removed"
					);
				}
			},
			webassembly: {
				enumerable: false,
				configurable: false,
				get() {
					throw new WebpackError(
						"Compilation.moduleTemplates.webassembly has been removed"
					);
				}
			}
		});

		this.moduleGraph = new ModuleGraph();
		this.chunkGraph = undefined;
		/** @type {Map<Module, CodeGenerationResult>} */
		this.codeGenerationResults = undefined;

		/** @type {AsyncQueue<TODO, TODO, Module>} */
		this.factorizeQueue = new AsyncQueue({
			name: "factorize",
			parallelism: options.parallelism || 100,
			processor: this._factorizeModule.bind(this)
		});
		/** @type {AsyncQueue<Module, string, Module>} */
		this.addModuleQueue = new AsyncQueue({
			name: "addModule",
			parallelism: options.parallelism || 100,
			getKey: module => module.identifier(),
			processor: this._addModule.bind(this)
		});
		/** @type {AsyncQueue<Module, Module, Module>} */
		this.buildQueue = new AsyncQueue({
			name: "build",
			parallelism: options.parallelism || 100,
			processor: this._buildModule.bind(this)
		});
		/** @type {AsyncQueue<Module, Module, Module>} */
		this.rebuildQueue = new AsyncQueue({
			name: "rebuild",
			parallelism: options.parallelism || 100,
			processor: this._rebuildModule.bind(this)
		});
		/** @type {AsyncQueue<Module, Module, Module>} */
		this.processDependenciesQueue = new AsyncQueue({
			name: "processDependencies",
			parallelism: options.parallelism || 100,
			processor: this._processModuleDependencies.bind(this)
		});

		/** @type {Map<string, EntryDependency[]>} */
		this.entryDependencies = new Map();
		/** @type {Map<string, Entrypoint>} */
		this.entrypoints = new Map();
		/** @type {Set<Chunk>} */
		this.chunks = new Set();
		arrayToSetDeprecation(this.chunks, "Compilation.chunks");
		/** @type {ChunkGroup[]} */
		this.chunkGroups = [];
		/** @type {Map<string, ChunkGroup>} */
		this.namedChunkGroups = new Map();
		/** @type {Map<string, Chunk>} */
		this.namedChunks = new Map();
		/** @type {Set<Module>} */
		this.modules = new Set();
		arrayToSetDeprecation(this.modules, "Compilation.modules");
		/** @private @type {Map<string, Module>} */
		this._modules = new Map();
		this.records = null;
		/** @type {string[]} */
		this.additionalChunkAssets = [];
		/** @type {CompilationAssets} */
		this.assets = {};
		/** @type {Map<string, AssetInfo>} */
		this.assetsInfo = new Map();
		/** @type {WebpackError[]} */
		this.errors = [];
		/** @type {WebpackError[]} */
		this.warnings = [];
		/** @type {Compilation[]} */
		this.children = [];
		/** @type {Map<string, LogEntry[]>} */
		this.logging = new Map();
		/** @type {Map<DepConstructor, ModuleFactory>} */
		this.dependencyFactories = new Map();
		/** @type {DependencyTemplates} */
		this.dependencyTemplates = new DependencyTemplates();
		this.childrenCounters = {};
		/** @type {Set<number|string>} */
		this.usedChunkIds = null;
		/** @type {Set<number>} */
		this.usedModuleIds = null;
		/** @type {boolean} */
		this.needAdditionalPass = false;
		/** @type {WeakSet<Module>} */
		this.builtModules = new WeakSet();
		/** @private @type {Map<Module, Callback[]>} */
		this._rebuildingModules = new Map();
		/** @type {Set<string>} */
		this.emittedAssets = new Set();
		/** @type {LazySet<string>} */
		this.fileDependencies = new LazySet();
		/** @type {LazySet<string>} */
		this.contextDependencies = new LazySet();
		/** @type {LazySet<string>} */
		this.missingDependencies = new LazySet();
		/** @type {LazySet<string>} */
		this.buildDependencies = new LazySet();
		// TODO webpack 6 remove
		this.compilationDependencies = {
			add: util.deprecate(
				item => this.fileDependencies.add(item),
				"Compilation.compilationDependencies is deprecated (used Compilation.fileDependencies instead)",
				"DEP_WEBPACK_COMPILATION_COMPILATION_DEPENDENCIES"
			)
		};
	}

	getStats() {
		return new Stats(this);
	}

	createStatsOptions(optionsOrPreset, context = {}) {
		if (
			typeof optionsOrPreset === "boolean" ||
			typeof optionsOrPreset === "string"
		) {
			optionsOrPreset = { preset: optionsOrPreset };
		}
		if (typeof optionsOrPreset === "object" && optionsOrPreset !== null) {
			// We use this method of shallow cloning this object to include
			// properties in the prototype chain
			const options = {};
			for (const key in optionsOrPreset) {
				options[key] = optionsOrPreset[key];
			}
			if (options.preset !== undefined) {
				this.hooks.statsPreset.for(options.preset).call(options, context);
			}
			this.hooks.statsNormalize.call(options, context);
			return options;
		} else {
			const options = {};
			this.hooks.statsNormalize.call(options, context);
			return options;
		}
	}

	createStatsFactory(options) {
		const statsFactory = new StatsFactory();
		this.hooks.statsFactory.call(statsFactory, options);
		return statsFactory;
	}

	createStatsPrinter(options) {
		const statsPrinter = new StatsPrinter();
		this.hooks.statsPrinter.call(statsPrinter, options);
		return statsPrinter;
	}

	/**
	 * @param {string | (function(): string)} name name of the logger, or function called once to get the logger name
	 * @returns {Logger} a logger with that name
	 */
	getLogger(name) {
		if (!name) {
			throw new TypeError("Compilation.getLogger(name) called without a name");
		}
		/** @type {LogEntry[] | undefined} */
		let logEntries;
		return new Logger((type, args) => {
			if (typeof name === "function") {
				name = name();
				if (!name) {
					throw new TypeError(
						"Compilation.getLogger(name) called with a function not returning a name"
					);
				}
			}
			let trace;
			switch (type) {
				case LogType.warn:
				case LogType.error:
				case LogType.trace:
					trace = ErrorHelpers.cutOffLoaderExecution(new Error("Trace").stack)
						.split("\n")
						.slice(3);
					break;
			}
			/** @type {LogEntry} */
			const logEntry = {
				time: Date.now(),
				type,
				args,
				trace
			};
			if (this.hooks.log.call(name, logEntry) === undefined) {
				if (logEntry.type === LogType.profileEnd) {
					// eslint-disable-next-line node/no-unsupported-features/node-builtins
					if (typeof console.profileEnd === "function") {
						// eslint-disable-next-line node/no-unsupported-features/node-builtins
						console.profileEnd(`[${name}] ${logEntry.args[0]}`);
					}
				}
				if (logEntries === undefined) {
					logEntries = this.logging.get(name);
					if (logEntries === undefined) {
						logEntries = [];
						this.logging.set(name, logEntries);
					}
				}
				logEntries.push(logEntry);
				if (logEntry.type === LogType.profile) {
					// eslint-disable-next-line node/no-unsupported-features/node-builtins
					if (typeof console.profile === "function") {
						// eslint-disable-next-line node/no-unsupported-features/node-builtins
						console.profile(`[${name}] ${logEntry.args[0]}`);
					}
				}
			}
		});
	}

	/**
	 * @param {Module} module module to be added that was created
	 * @param {ModuleCallback} callback returns the module in the compilation,
	 * it could be the passed one (if new), or an already existing in the compilation
	 * @returns {void}
	 */
	addModule(module, callback) {
		this.addModuleQueue.add(module, callback);
	}

	/**
	 * @param {Module} module module to be added that was created
	 * @param {ModuleCallback} callback returns the module in the compilation,
	 * it could be the passed one (if new), or an already existing in the compilation
	 * @returns {void}
	 */
	_addModule(module, callback) {
		const identifier = module.identifier();
		const alreadyAddedModule = this._modules.get(identifier);
		if (alreadyAddedModule) {
			return callback(null, alreadyAddedModule);
		}

		const currentProfile = this.profile
			? this.moduleGraph.getProfile(module)
			: undefined;
		if (currentProfile !== undefined) {
			currentProfile.markRestoringStart();
		}

		const cacheName = `${this.compilerPath}/module/${identifier}`;
		this.cache.get(cacheName, null, (err, cacheModule) => {
			if (err) return callback(new ModuleRestoreError(module, err));

			if (currentProfile !== undefined) {
				currentProfile.markRestoringEnd();
				currentProfile.markIntegrationStart();
			}

			if (cacheModule) {
				cacheModule.updateCacheModule(module);

				module = cacheModule;
			}
			this._modules.set(identifier, module);
			this.modules.add(module);
			ModuleGraph.setModuleGraphForModule(module, this.moduleGraph);
			if (currentProfile !== undefined) {
				currentProfile.markIntegrationEnd();
			}
			callback(null, module);
		});
	}

	/**
	 * Fetches a module from a compilation by its identifier
	 * @param {Module} module the module provided
	 * @returns {Module} the module requested
	 */
	getModule(module) {
		const identifier = module.identifier();
		return this._modules.get(identifier);
	}

	/**
	 * Attempts to search for a module by its identifier
	 * @param {string} identifier identifier (usually path) for module
	 * @returns {Module|undefined} attempt to search for module and return it, else undefined
	 */
	findModule(identifier) {
		return this._modules.get(identifier);
	}

	/**
	 * Schedules a build of the module object
	 *
	 * @param {Module} module module to be built
	 * @param {ModuleCallback} callback the callback
	 * @returns {void}
	 */
	buildModule(module, callback) {
		this.buildQueue.add(module, callback);
	}

	/**
	 * Builds the module object
	 *
	 * @param {Module} module module to be built
	 * @param {ModuleCallback} callback the callback
	 * @returns {void}
	 */
	_buildModule(module, callback) {
		const currentProfile = this.profile
			? this.moduleGraph.getProfile(module)
			: undefined;
		if (currentProfile !== undefined) {
			currentProfile.markBuildingStart();
		}

		module.needBuild(
			{
				fileSystemInfo: this.fileSystemInfo
			},
			(err, needBuild) => {
				if (err) return callback(err);

				if (!needBuild) {
					if (currentProfile !== undefined) {
						currentProfile.markBuildingEnd();
					}
					this.hooks.stillValidModule.call(module);
					return callback();
				}

				this.hooks.buildModule.call(module);
				this.builtModules.add(module);
				module.build(
					this.options,
					this,
					this.resolverFactory.get("normal", module.resolveOptions),
					this.inputFileSystem,
					err => {
						if (currentProfile !== undefined) {
							currentProfile.markBuildingEnd();
						}
						if (err) {
							this.hooks.failedModule.call(module, err);
							return callback(err);
						}
						if (currentProfile !== undefined) {
							currentProfile.markStoringStart();
						}
						this.cache.store(
							`${this.compilerPath}/module/${module.identifier()}`,
							null,
							module,
							err => {
								if (currentProfile !== undefined) {
									currentProfile.markStoringEnd();
								}
								if (err) {
									this.hooks.failedModule.call(module, err);
									return callback(err);
								}
								this.hooks.succeedModule.call(module);
								return callback();
							}
						);
					}
				);
			}
		);
	}

	/**
	 * @param {Module} module to be processed for deps
	 * @param {ModuleCallback} callback callback to be triggered
	 * @returns {void}
	 */
	processModuleDependencies(module, callback) {
		this.processDependenciesQueue.add(module, callback);
	}

	/**
	 * @param {Module} module to be processed for deps
	 * @param {ModuleCallback} callback callback to be triggered
	 * @returns {void}
	 */
	_processModuleDependencies(module, callback) {
		const dependencies = new Map();

		const sortedDependencies = [];

		let currentBlock = module;

		let factoryCacheKey;
		let factoryCacheValue;
		let factoryCacheValue2;
		let listCacheKey;
		let listCacheValue;

		const processDependency = dep => {
			this.moduleGraph.setParents(dep, currentBlock, module);
			const resourceIdent = dep.getResourceIdentifier();
			if (resourceIdent) {
				const constructor = dep.constructor;
				let innerMap;
				let factory;
				if (factoryCacheKey === constructor) {
					innerMap = factoryCacheValue;
					if (listCacheKey === resourceIdent) {
						listCacheValue.push(dep);
						return;
					}
				} else {
					factory = this.dependencyFactories.get(dep.constructor);
					if (factory === undefined) {
						throw new Error(
							`No module factory available for dependency type: ${dep.constructor.name}`
						);
					}
					innerMap = dependencies.get(factory);
					if (innerMap === undefined) {
						dependencies.set(factory, (innerMap = new Map()));
					}
					factoryCacheKey = constructor;
					factoryCacheValue = innerMap;
					factoryCacheValue2 = factory;
				}
				let list = innerMap.get(resourceIdent);
				if (list === undefined) {
					innerMap.set(resourceIdent, (list = []));
					sortedDependencies.push({
						factory: factoryCacheValue2,
						dependencies: list,
						originModule: module
					});
				}
				list.push(dep);
				listCacheKey = resourceIdent;
				listCacheValue = list;
			}
		};

		const processDependenciesBlock = block => {
			if (block.dependencies) {
				currentBlock = block;
				for (const dep of block.dependencies) processDependency(dep);
			}
			if (block.blocks) {
				for (const b of block.blocks) processDependenciesBlock(b);
			}
		};

		try {
			processDependenciesBlock(module);
		} catch (e) {
			return callback(e);
		}

		if (sortedDependencies.length === 0) {
			callback();
			return;
		}

		process.nextTick(() => {
			// This is nested so we need to allow one additional task
			this.processDependenciesQueue.increaseParallelism();

			asyncLib.forEach(
				sortedDependencies,
				(item, callback) => {
					this.handleModuleCreation(item, err => {
						// In V8, the Error objects keep a reference to the functions on the stack. These warnings &
						// errors are created inside closures that keep a reference to the Compilation, so errors are
						// leaking the Compilation object.
						if (err && this.bail) {
							// eslint-disable-next-line no-self-assign
							err.stack = err.stack;
							return callback(err);
						}
						callback();
					});
				},
				err => {
					this.processDependenciesQueue.decreaseParallelism();

					return callback(err);
				}
			);
		});
	}

	/**
	 * @typedef {Object} HandleModuleCreationOptions
	 * @property {ModuleFactory} factory
	 * @property {Dependency[]} dependencies
	 * @property {Module | null} originModule
	 * @property {string=} context
	 */

	/**
	 * @param {HandleModuleCreationOptions} options options object
	 * @param {ModuleCallback} callback callback
	 * @returns {void}
	 */
	handleModuleCreation(
		{ factory, dependencies, originModule, context },
		callback
	) {
		const moduleGraph = this.moduleGraph;

		const currentProfile = this.profile ? new ModuleProfile() : undefined;

		this.factorizeModule(
			{ currentProfile, factory, dependencies, originModule, context },
			(err, newModule) => {
				if (err) {
					if (dependencies.every(d => d.optional)) {
						this.warnings.push(err);
					} else {
						this.errors.push(err);
					}
					return callback(err);
				}

				if (!newModule) {
					return callback();
				}

				if (currentProfile !== undefined) {
					moduleGraph.setProfile(newModule, currentProfile);
				}

				this.addModule(newModule, (err, module) => {
					if (err) {
						if (!err.module) {
							err.module = module;
						}
						this.errors.push(err);

						return callback(err);
					}

					for (let i = 0; i < dependencies.length; i++) {
						const dependency = dependencies[i];
						moduleGraph.setResolvedModule(originModule, dependency, module);
					}

					moduleGraph.setIssuerIfUnset(
						module,
						originModule !== undefined ? originModule : null
					);
					if (module !== newModule) {
						if (currentProfile !== undefined) {
							const otherProfile = moduleGraph.getProfile(module);
							if (otherProfile !== undefined) {
								currentProfile.mergeInto(otherProfile);
							} else {
								moduleGraph.setProfile(module, currentProfile);
							}
						}
					}

					this.buildModule(module, err => {
						if (err) {
							if (!err.module) {
								err.module = module;
							}
							this.errors.push(err);

							return callback(err);
						}

						// This avoids deadlocks for circular dependencies
						if (this.processDependenciesQueue.isProcessing(module)) {
							return callback();
						}

						this.processModuleDependencies(module, err => {
							if (err) {
								return callback(err);
							}
							callback(null, module);
						});
					});
				});
			}
		);
	}

	/**
	 * @typedef {Object} FactorizeModuleOptions
	 * @property {ModuleProfile} currentProfile
	 * @property {ModuleFactory} factory
	 * @property {Dependency[]} dependencies
	 * @property {Module | null} originModule
	 * @property {string=} context
	 */

	/**
	 * @param {FactorizeModuleOptions} options options object
	 * @param {ModuleCallback} callback callback
	 * @returns {void}
	 */
	factorizeModule(options, callback) {
		this.factorizeQueue.add(options, callback);
	}

	/**
	 * @param {FactorizeModuleOptions} options options object
	 * @param {ModuleCallback} callback callback
	 * @returns {void}
	 */
	_factorizeModule(
		{ currentProfile, factory, dependencies, originModule, context },
		callback
	) {
		if (currentProfile !== undefined) {
			currentProfile.markFactoryStart();
		}
		factory.create(
			{
				contextInfo: {
					issuer: originModule ? originModule.nameForCondition() : "",
					compiler: this.compiler.name
				},
				resolveOptions: originModule ? originModule.resolveOptions : undefined,
				context: context
					? context
					: originModule
					? originModule.context
					: this.compiler.context,
				dependencies: dependencies
			},
			(err, result) => {
				if (result) {
					// TODO webpack 6: remove
					// For backward-compat
					if (result.module === undefined && result instanceof Module) {
						result = {
							module: result
						};
					}
					const {
						fileDependencies,
						contextDependencies,
						missingDependencies
					} = result;
					if (fileDependencies) {
						this.fileDependencies.addAll(fileDependencies);
					}
					if (contextDependencies) {
						this.contextDependencies.addAll(contextDependencies);
					}
					if (missingDependencies) {
						this.missingDependencies.addAll(missingDependencies);
					}
				}
				if (err) {
					const notFoundError = new ModuleNotFoundError(
						originModule,
						err,
						dependencies.map(d => d.loc).filter(Boolean)[0]
					);
					return callback(notFoundError);
				}
				if (!result) {
					return callback();
				}
				const newModule = result.module;
				if (!newModule) {
					return callback();
				}
				if (currentProfile !== undefined) {
					currentProfile.markFactoryEnd();
				}

				callback(null, newModule);
			}
		);
	}

	/**
	 *
	 * @param {string} context context string path
	 * @param {Dependency} dependency dependency used to create Module chain
	 * @param {ModuleCallback} callback callback for when module chain is complete
	 * @returns {void} will throw if dependency instance is not a valid Dependency
	 */
	addModuleChain(context, dependency, callback) {
		if (
			typeof dependency !== "object" ||
			dependency === null ||
			!dependency.constructor
		) {
			return callback(
				new WebpackError("Parameter 'dependency' must be a Dependency")
			);
		}
		const Dep = /** @type {DepConstructor} */ (dependency.constructor);
		const moduleFactory = this.dependencyFactories.get(Dep);
		if (!moduleFactory) {
			return callback(
				new WebpackError(
					`No dependency factory available for this dependency type: ${dependency.constructor.name}`
				)
			);
		}

		this.handleModuleCreation(
			{
				factory: moduleFactory,
				dependencies: [dependency],
				originModule: null,
				context
			},
			err => {
				if (err && this.bail) {
					callback(err);
					this.buildQueue.stop();
					this.rebuildQueue.stop();
					this.processDependenciesQueue.stop();
					this.factorizeQueue.stop();
				} else {
					callback();
				}
			}
		);
	}

	/**
	 *
	 * @param {string} context context path for entry
	 * @param {EntryDependency} entry entry dependency being created
	 * @param {string} name name of entry
	 * @param {ModuleCallback} callback callback function
	 * @returns {void} returns
	 */
	addEntry(context, entry, name, callback) {
		this.hooks.addEntry.call(entry, name);

		let entriesArray = this.entryDependencies.get(name);
		if (entriesArray === undefined) {
			entriesArray = [];
			this.entryDependencies.set(name, entriesArray);
		}
		entriesArray.push(entry);

		this.addModuleChain(context, entry, (err, module) => {
			if (err) {
				this.hooks.failedEntry.call(entry, name, err);
				return callback(err);
			}
			this.hooks.succeedEntry.call(entry, name, module);
			return callback(null, module);
		});
	}

	/**
	 * @param {Module} module module to be rebuilt
	 * @param {ModuleCallback} callback callback when module finishes rebuilding
	 * @returns {void}
	 */
	rebuildModule(module, callback) {
		this.rebuildQueue.add(module, callback);
	}

	/**
	 * @param {Module} module module to be rebuilt
	 * @param {ModuleCallback} callback callback when module finishes rebuilding
	 * @returns {void}
	 */
	_rebuildModule(module, callback) {
		this.hooks.rebuildModule.call(module);
		const oldDependencies = module.dependencies.slice();
		const oldBlocks = module.blocks.slice();
		module.invalidateBuild();
		this.buildQueue.invalidate(module);
		this.buildModule(module, err => {
			if (err) {
				return this.hooks.finishRebuildingModule.callAsync(module, err2 => {
					if (err2) {
						callback(
							makeWebpackError(err2, "Compilation.hooks.finishRebuildingModule")
						);
						return;
					}
					callback(err);
				});
			}

			this.processModuleDependencies(module, err => {
				if (err) return callback(err);
				this.removeReasonsOfDependencyBlock(module, {
					dependencies: oldDependencies,
					blocks: oldBlocks
				});
				this.hooks.finishRebuildingModule.callAsync(module, err2 => {
					if (err2) {
						callback(
							makeWebpackError(err2, "Compilation.hooks.finishRebuildingModule")
						);
						return;
					}
					callback(null, module);
				});
			});
		});
	}

	finish(callback) {
		const { moduleGraph, modules } = this;
		for (const module of modules) {
			moduleGraph.finishModule(module);
		}
		this.hooks.finishModules.callAsync(modules, err => {
			if (err) return callback(err);

			// extract warnings and errors from modules
			for (const module of modules) {
				this.reportDependencyErrorsAndWarnings(module, [module]);
				if (module.errors.length > 0) {
					if (module.isOptional(this.moduleGraph)) {
						for (const error of module.errors) {
							if (!error.module) {
								error.module = module;
							}
							this.warnings.push(error);
						}
					} else {
						for (const error of module.errors) {
							if (!error.module) {
								error.module = module;
							}
							this.errors.push(error);
						}
					}
				}
				for (const warning of module.warnings) {
					if (!warning.module) {
						warning.module = module;
					}
					this.warnings.push(warning);
				}
			}

			callback();
		});
	}

	unseal() {
		this.hooks.unseal.call();
		this.chunks.clear();
		this.chunkGroups.length = 0;
		this.namedChunks.clear();
		this.namedChunkGroups.clear();
		this.entrypoints.clear();
		this.additionalChunkAssets.length = 0;
		this.assets = {};
		this.assetsInfo.clear();
		this.moduleGraph.removeAllModuleAttributes();
	}

	/**
	 * @param {Callback} callback signals when the call finishes
	 * @returns {void}
	 */
	seal(callback) {
		const chunkGraph = new ChunkGraph(this.moduleGraph);
		this.chunkGraph = chunkGraph;

		for (const module of this.modules) {
			ChunkGraph.setChunkGraphForModule(module, chunkGraph);
		}

		this.hooks.seal.call();

		while (this.hooks.optimizeDependencies.call(this.modules)) {
			/* empty */
		}
		this.hooks.afterOptimizeDependencies.call(this.modules);

		this.hooks.beforeChunks.call();
		for (const [name, dependencies] of this.entryDependencies) {
			const chunk = this.addChunk(name);
			chunk.name = name;
			const entrypoint = new Entrypoint(name);
			entrypoint.setRuntimeChunk(chunk);
			this.namedChunkGroups.set(name, entrypoint);
			this.entrypoints.set(name, entrypoint);
			this.chunkGroups.push(entrypoint);
			connectChunkGroupAndChunk(entrypoint, chunk);

			for (const dep of dependencies) {
				entrypoint.addOrigin(null, { name }, dep.request);

				const module = this.moduleGraph.getModule(dep);
				if (module) {
					chunkGraph.connectChunkAndModule(chunk, module);
					chunkGraph.connectChunkAndEntryModule(chunk, module, entrypoint);
					this.assignDepth(module);
				}
			}
		}
		buildChunkGraph(
			this,
			/** @type {Entrypoint[]} */ (this.chunkGroups.slice())
		);
		this.hooks.afterChunks.call(this.chunks);

		this.hooks.optimize.call();

		while (this.hooks.optimizeModules.call(this.modules)) {
			/* empty */
		}
		this.hooks.afterOptimizeModules.call(this.modules);

		while (this.hooks.optimizeChunks.call(this.chunks, this.chunkGroups)) {
			/* empty */
		}
		this.hooks.afterOptimizeChunks.call(this.chunks, this.chunkGroups);

		this.hooks.optimizeTree.callAsync(this.chunks, this.modules, err => {
			if (err) {
				return callback(
					makeWebpackError(err, "Compilation.hooks.optimizeTree")
				);
			}

			this.hooks.afterOptimizeTree.call(this.chunks, this.modules);

			while (this.hooks.optimizeChunkModules.call(this.chunks, this.modules)) {
				/* empty */
			}
			this.hooks.afterOptimizeChunkModules.call(this.chunks, this.modules);

			const shouldRecord = this.hooks.shouldRecord.call() !== false;

			this.hooks.reviveModules.call(this.modules, this.records);
			this.hooks.beforeModuleIds.call(this.modules);
			this.hooks.moduleIds.call(this.modules);
			this.hooks.optimizeModuleIds.call(this.modules);
			this.hooks.afterOptimizeModuleIds.call(this.modules);

			this.hooks.reviveChunks.call(this.chunks, this.records);
			this.hooks.beforeChunkIds.call(this.chunks);
			this.hooks.chunkIds.call(this.chunks);
			this.hooks.optimizeChunkIds.call(this.chunks);
			this.hooks.afterOptimizeChunkIds.call(this.chunks);

			this.sortItemsWithChunkIds();

			if (shouldRecord) {
				this.hooks.recordModules.call(this.modules, this.records);
				this.hooks.recordChunks.call(this.chunks, this.records);
			}

			this.hooks.optimizeCodeGeneration.call(this.modules);

			this.hooks.beforeModuleHash.call();
			this.createModuleHashes();
			this.hooks.afterModuleHash.call();

			this.hooks.beforeCodeGeneration.call();
			this.codeGenerationResults = this.codeGeneration();
			this.hooks.afterCodeGeneration.call();

			this.hooks.beforeRuntimeRequirements.call();
			this.processRuntimeRequirements(this.entrypoints.values());
			this.hooks.afterRuntimeRequirements.call();

			this.hooks.beforeHash.call();
			this.createHash();
			this.hooks.afterHash.call();

			if (shouldRecord) {
				this.hooks.recordHash.call(this.records);
			}

			this.clearAssets();

			this.hooks.beforeModuleAssets.call();
			this.createModuleAssets();

			const cont = () => {
				this.hooks.additionalChunkAssets.call(this.chunks);
				this.summarizeDependencies();
				if (shouldRecord) {
					this.hooks.record.call(this, this.records);
				}

				this.hooks.additionalAssets.callAsync(err => {
					if (err) {
						return callback(
							makeWebpackError(err, "Compilation.hooks.additionalAssets")
						);
					}
					this.hooks.optimizeChunkAssets.callAsync(this.chunks, err => {
						if (err) {
							return callback(
								makeWebpackError(err, "Compilation.hooks.optimizeChunkAssets")
							);
						}
						this.hooks.afterOptimizeChunkAssets.call(this.chunks);
						this.hooks.optimizeAssets.callAsync(this.assets, err => {
							if (err) {
								return callback(
									makeWebpackError(err, "Compilation.hooks.optimizeAssets")
								);
							}
							this.hooks.afterOptimizeAssets.call(this.assets);
							if (this.hooks.needAdditionalSeal.call()) {
								this.unseal();
								return this.seal(callback);
							}
							this.cache.storeBuildDependencies(this.buildDependencies, err => {
								if (err) {
									return callback(err);
								}
								return this.hooks.afterSeal.callAsync(callback);
							});
						});
					});
				});
			};

			if (this.hooks.shouldGenerateChunkAssets.call() !== false) {
				this.hooks.beforeChunkAssets.call();
				this.createChunkAssets(err => {
					if (err) {
						return callback(err);
					}
					cont();
				});
			} else {
				cont();
			}
		});
	}

	/**
	 * @param {Module} module moulde to report from
	 * @param {DependenciesBlock[]} blocks blocks to report from
	 * @returns {void}
	 */
	reportDependencyErrorsAndWarnings(module, blocks) {
		for (let indexBlock = 0; indexBlock < blocks.length; indexBlock++) {
			const block = blocks[indexBlock];
			const dependencies = block.dependencies;

			for (let indexDep = 0; indexDep < dependencies.length; indexDep++) {
				const d = dependencies[indexDep];

				const warnings = d.getWarnings(this.moduleGraph);
				if (warnings) {
					for (let indexWar = 0; indexWar < warnings.length; indexWar++) {
						const w = warnings[indexWar];

						const warning = new ModuleDependencyWarning(module, w, d.loc);
						this.warnings.push(warning);
					}
				}
				const errors = d.getErrors(this.moduleGraph);
				if (errors) {
					for (let indexErr = 0; indexErr < errors.length; indexErr++) {
						const e = errors[indexErr];

						const error = new ModuleDependencyError(module, e, d.loc);
						this.errors.push(error);
					}
				}
			}

			this.reportDependencyErrorsAndWarnings(module, block.blocks);
		}
	}

	codeGeneration() {
		const {
			chunkGraph,
			moduleGraph,
			dependencyTemplates,
			runtimeTemplate
		} = this;
		const results = new Map();
		const errors = [];
		for (const module of this.modules) {
			if (chunkGraph.getNumberOfModuleChunks(module) > 0) {
				try {
					const r = module.codeGeneration({
						chunkGraph,
						moduleGraph,
						dependencyTemplates,
						runtimeTemplate
					});
					results.set(module, r);
				} catch (err) {
					errors.push(new CodeGenerationError(module, err));
					results.set(module, {
						sources: new Map(),
						runtimeRequirements: null
					});
				}
			}
		}
		if (errors.length > 0) {
			errors.sort(compareSelect(err => err.module, compareModulesByIdentifier));
			for (const error of errors) {
				this.errors.push(error);
			}
		}
		return results;
	}

	/**
	 * @param {Iterable<Entrypoint>} entrypoints the entrypoints
	 * @returns {void}
	 */
	processRuntimeRequirements(entrypoints) {
		const { chunkGraph } = this;

		const additionalModuleRuntimeRequirements = /** @type {TODO} */ (this.hooks
			.additionalModuleRuntimeRequirements);
		const runtimeRequirementInModule = this.hooks.runtimeRequirementInModule;
		for (const module of this.modules) {
			if (chunkGraph.getNumberOfModuleChunks(module) > 0) {
				let set;
				const runtimeRequirements = this.codeGenerationResults.get(module)
					.runtimeRequirements;
				if (runtimeRequirements) {
					set = new Set(runtimeRequirements);
				} else if (additionalModuleRuntimeRequirements.isUsed()) {
					set = new Set();
				} else {
					continue;
				}
				additionalModuleRuntimeRequirements.call(module, set);

				for (const r of set) {
					const hook = runtimeRequirementInModule.get(r);
					if (hook !== undefined) hook.call(module, set);
				}
				chunkGraph.addModuleRuntimeRequirements(module, set);
			}
		}

		for (const chunk of this.chunks) {
			const set = new Set();
			for (const module of chunkGraph.getChunkModulesIterable(chunk)) {
				const runtimeRequirements = chunkGraph.getModuleRuntimeRequirements(
					module
				);
				for (const r of runtimeRequirements) set.add(r);
			}
			this.hooks.additionalChunkRuntimeRequirements.call(chunk, set);

			for (const r of set) {
				this.hooks.runtimeRequirementInChunk.for(r).call(chunk, set);
			}

			chunkGraph.addChunkRuntimeRequirements(chunk, set);
		}

		const treeEntries = new Set(
			Array.from(entrypoints).map(ep => ep.getRuntimeChunk())
		);

		for (const chunk of treeEntries) {
			const allReferencedChunks = new Set();
			const queue = new Set(chunk.groupsIterable);
			for (const chunkGroup of queue) {
				for (const chunk of chunkGroup.chunks) {
					allReferencedChunks.add(chunk);
				}
				for (const child of chunkGroup.childrenIterable) {
					queue.add(child);
				}
			}

			const set = new Set();
			for (const chunk of allReferencedChunks) {
				const runtimeRequirements = chunkGraph.getChunkRuntimeRequirements(
					chunk
				);
				for (const r of runtimeRequirements) set.add(r);
			}

			this.hooks.additionalTreeRuntimeRequirements.call(chunk, set);

			for (const r of set) {
				this.hooks.runtimeRequirementInTree.for(r).call(chunk, set);
			}

			chunkGraph.addTreeRuntimeRequirements(chunk, set);
		}
	}

	/**
	 * @param {Chunk} chunk target chunk
	 * @param {RuntimeModule} module runtime module
	 * @returns {void}
	 */
	addRuntimeModule(chunk, module) {
		// Deprecated ModuleGraph association
		ModuleGraph.setModuleGraphForModule(module, this.moduleGraph);

		// add it to the list
		this.modules.add(module);
		this._modules.set(module.identifier(), module);

		// connect to the chunk graph
		this.chunkGraph.connectChunkAndModule(chunk, module);
		this.chunkGraph.connectChunkAndRuntimeModule(chunk, module);

		// attach runtime module
		module.attach(this, chunk);

		// Setup internals
		const exportsInfo = this.moduleGraph.getExportsInfo(module);
		exportsInfo.setHasProvideInfo();
		exportsInfo.setUsedForSideEffectsOnly();
		this.chunkGraph.addModuleRuntimeRequirements(module, [
			RuntimeGlobals.requireScope
		]);

		// runtime modules don't need ids
		this.chunkGraph.setModuleId(module, "");

		// Call hook
		this.hooks.runtimeModule.call(module, chunk);
	}

	/**
	 * @param {string|ChunkGroupOptions} groupOptions options for the chunk group
	 * @param {Module} module the module the references the chunk group
	 * @param {DependencyLocation} loc the location from with the chunk group is referenced (inside of module)
	 * @param {string} request the request from which the the chunk group is referenced
	 * @returns {ChunkGroup} the new or existing chunk group
	 */
	addChunkInGroup(groupOptions, module, loc, request) {
		if (typeof groupOptions === "string") {
			groupOptions = { name: groupOptions };
		}
		const name = groupOptions.name;
		if (name) {
			const chunkGroup = this.namedChunkGroups.get(name);
			if (chunkGroup !== undefined) {
				chunkGroup.addOptions(groupOptions);
				if (module) {
					chunkGroup.addOrigin(module, loc, request);
				}
				return chunkGroup;
			}
		}
		const chunkGroup = new ChunkGroup(groupOptions);
		if (module) chunkGroup.addOrigin(module, loc, request);
		const chunk = this.addChunk(name);

		connectChunkGroupAndChunk(chunkGroup, chunk);

		this.chunkGroups.push(chunkGroup);
		if (name) {
			this.namedChunkGroups.set(name, chunkGroup);
		}
		return chunkGroup;
	}

	/**
	 * This method first looks to see if a name is provided for a new chunk,
	 * and first looks to see if any named chunks already exist and reuse that chunk instead.
	 *
	 * @param {string=} name optional chunk name to be provided
	 * @returns {Chunk} create a chunk (invoked during seal event)
	 */
	addChunk(name) {
		if (name) {
			const chunk = this.namedChunks.get(name);
			if (chunk !== undefined) {
				return chunk;
			}
		}
		const chunk = new Chunk(name);
		this.chunks.add(chunk);
		ChunkGraph.setChunkGraphForChunk(chunk, this.chunkGraph);
		if (name) {
			this.namedChunks.set(name, chunk);
		}
		return chunk;
	}

	/**
	 * @param {Module} module module to assign depth
	 * @returns {void}
	 */
	assignDepth(module) {
		const moduleGraph = this.moduleGraph;

		const queue = new Set([module]);
		let depth;

		moduleGraph.setDepth(module, 0);

		/**
		 * @param {Module} module module for processeing
		 * @returns {void}
		 */
		const processModule = module => {
			if (!moduleGraph.setDepthIfLower(module, depth)) return;
			queue.add(module);
		};

		for (module of queue) {
			queue.delete(module);
			depth = moduleGraph.getDepth(module) + 1;

			for (const connection of moduleGraph.getOutgoingConnections(module)) {
				const refModule = connection.module;
				if (refModule) {
					processModule(refModule);
				}
			}
		}
	}

	/**
	 * @param {Dependency} dependency the dependency
	 * @returns {string[][]} referenced exports
	 */
	getDependencyReferencedExports(dependency) {
		const referencedExports = dependency.getReferencedExports(this.moduleGraph);
		return this.hooks.dependencyReferencedExports.call(
			referencedExports,
			dependency
		);
	}

	/**
	 *
	 * @param {Module} module module relationship for removal
	 * @param {DependenciesBlockLike} block //TODO: good description
	 * @returns {void}
	 */
	removeReasonsOfDependencyBlock(module, block) {
		const chunkGraph = this.chunkGraph;
		const iteratorDependency = d => {
			if (!d.module) {
				return;
			}
			if (d.module.removeReason(module, d)) {
				for (const chunk of chunkGraph.getModuleChunksIterable(d.module)) {
					this.patchChunksAfterReasonRemoval(d.module, chunk);
				}
			}
		};

		if (block.blocks) {
			for (const b of block.blocks) {
				this.removeReasonsOfDependencyBlock(module, b);
			}
		}

		if (block.dependencies) {
			for (const dep of block.dependencies) iteratorDependency(dep);
		}
	}

	/**
	 * @param {Module} module module to patch tie
	 * @param {Chunk} chunk chunk to patch tie
	 * @returns {void}
	 */
	patchChunksAfterReasonRemoval(module, chunk) {
		if (!module.hasReasons(this.moduleGraph)) {
			this.removeReasonsOfDependencyBlock(module, module);
		}
		if (!module.hasReasonForChunk(chunk, this.moduleGraph, this.chunkGraph)) {
			if (this.chunkGraph.isModuleInChunk(module, chunk)) {
				this.chunkGraph.disconnectChunkAndModule(chunk, module);
				this.removeChunkFromDependencies(module, chunk);
			}
		}
	}

	/**
	 *
	 * @param {DependenciesBlock} block block tie for Chunk
	 * @param {Chunk} chunk chunk to remove from dep
	 * @returns {void}
	 */
	removeChunkFromDependencies(block, chunk) {
		const iteratorDependency = d => {
			if (!d.module) {
				return;
			}
			this.patchChunksAfterReasonRemoval(d.module, chunk);
		};

		const blocks = block.blocks;
		for (let indexBlock = 0; indexBlock < blocks.length; indexBlock++) {
			const asyncBlock = blocks[indexBlock];
			const chunkGroup = this.chunkGraph.getBlockChunkGroup(asyncBlock);
			// Grab all chunks from the first Block's AsyncDepBlock
			const chunks = chunkGroup.chunks;
			// For each chunk in chunkGroup
			for (let indexChunk = 0; indexChunk < chunks.length; indexChunk++) {
				const iteratedChunk = chunks[indexChunk];
				chunkGroup.removeChunk(iteratedChunk);
				// Recurse
				this.removeChunkFromDependencies(block, iteratedChunk);
			}
		}

		if (block.dependencies) {
			for (const dep of block.dependencies) iteratorDependency(dep);
		}
	}

	sortItemsWithChunkIds() {
		for (const chunkGroup of this.chunkGroups) {
			chunkGroup.sortItems();
		}

		this.errors.sort(compareErrors);
		this.warnings.sort(compareErrors);
		this.children.sort(byNameOrHash);
	}

	summarizeDependencies() {
		for (
			let indexChildren = 0;
			indexChildren < this.children.length;
			indexChildren++
		) {
			const child = this.children[indexChildren];

			this.fileDependencies.addAll(child.fileDependencies);
			this.contextDependencies.addAll(child.contextDependencies);
			this.missingDependencies.addAll(child.missingDependencies);
			this.buildDependencies.addAll(child.buildDependencies);
		}

		for (const module of this.modules) {
			const fileDependencies = module.buildInfo.fileDependencies;
			const contextDependencies = module.buildInfo.contextDependencies;
			const missingDependencies = module.buildInfo.missingDependencies;
			if (fileDependencies) {
				this.fileDependencies.addAll(fileDependencies);
			}
			if (contextDependencies) {
				this.contextDependencies.addAll(contextDependencies);
			}
			if (missingDependencies) {
				this.missingDependencies.addAll(missingDependencies);
			}
		}
	}

	createModuleHashes() {
		const chunkGraph = this.chunkGraph;
		const { hashFunction, hashDigest, hashDigestLength } = this.outputOptions;
		for (const module of this.modules) {
			const moduleHash = createHash(hashFunction);
			module.updateHash(moduleHash, chunkGraph);
			const moduleHashDigest = /** @type {string} */ (moduleHash.digest(
				hashDigest
			));
			chunkGraph.setModuleHashes(
				module,
				moduleHashDigest,
				moduleHashDigest.substr(0, hashDigestLength)
			);
		}
	}

	createHash() {
		const chunkGraph = this.chunkGraph;
		const outputOptions = this.outputOptions;
		const hashFunction = outputOptions.hashFunction;
		const hashDigest = outputOptions.hashDigest;
		const hashDigestLength = outputOptions.hashDigestLength;
		const hash = createHash(hashFunction);
		if (outputOptions.hashSalt) {
			hash.update(outputOptions.hashSalt);
		}
		this.hooks.fullHash.call(hash);
		for (const child of this.children) {
			hash.update(child.hash);
		}
		for (const warning of this.warnings) {
			hash.update(`${warning.message}`);
		}
		for (const error of this.errors) {
			hash.update(`${error.message}`);
		}

		// clone needed as sort below is inplace mutation
		const chunks = Array.from(this.chunks);
		/**
		 * sort here will bring all "falsy" values to the beginning
		 * this is needed as the "hasRuntime()" chunks are dependent on the
		 * hashes of the non-runtime chunks.
		 */
		chunks.sort((a, b) => {
			const aEntry = a.hasRuntime();
			const bEntry = b.hasRuntime();
			if (aEntry && !bEntry) return 1;
			if (!aEntry && bEntry) return -1;
			return byId(a, b);
		});
		for (let i = 0; i < chunks.length; i++) {
			const chunk = chunks[i];
			// Last minute module hash generation for modules that depend on chunk hashes
			for (const module of chunkGraph.getChunkModulesIterable(chunk)) {
				if (!chunkGraph.getModuleHash(module)) {
					const moduleHash = createHash(hashFunction);
					module.updateHash(moduleHash, chunkGraph);
					const moduleHashDigest = /** @type {string} */ (moduleHash.digest(
						hashDigest
					));
					chunkGraph.setModuleHashes(
						module,
						moduleHashDigest,
						moduleHashDigest.substr(0, hashDigestLength)
					);
				}
			}
			const chunkHash = createHash(hashFunction);
			try {
				if (outputOptions.hashSalt) {
					chunkHash.update(outputOptions.hashSalt);
				}
				chunk.updateHash(chunkHash, chunkGraph);
				this.hooks.chunkHash.call(chunk, chunkHash, {
					chunkGraph,
					moduleGraph: this.moduleGraph,
					runtimeTemplate: this.runtimeTemplate
				});
				chunk.hash = /** @type {string} */ (chunkHash.digest(hashDigest));
				hash.update(chunk.hash);
				chunk.renderedHash = chunk.hash.substr(0, hashDigestLength);
				this.hooks.contentHash.call(chunk);
			} catch (err) {
				this.errors.push(new ChunkRenderError(chunk, "", err));
			}
		}
		this.fullHash = /** @type {string} */ (hash.digest(hashDigest));
		this.hash = this.fullHash.substr(0, hashDigestLength);
	}

	/**
	 * @param {string} update extra information
	 * @returns {void}
	 */
	modifyHash(update) {
		const outputOptions = this.outputOptions;
		const hashFunction = outputOptions.hashFunction;
		const hashDigest = outputOptions.hashDigest;
		const hashDigestLength = outputOptions.hashDigestLength;
		const hash = createHash(hashFunction);
		hash.update(this.fullHash);
		hash.update(update);
		this.fullHash = /** @type {string} */ (hash.digest(hashDigest));
		this.hash = this.fullHash.substr(0, hashDigestLength);
	}

	/**
	 * @param {string} file file name
	 * @param {Source} source asset source
	 * @param {AssetInfo} assetInfo extra asset information
	 * @returns {void}
	 */
	emitAsset(file, source, assetInfo = {}) {
		if (this.assets[file]) {
			if (!isSourceEqual(this.assets[file], source)) {
				// TODO webpack 5: make this an error instead
				this.warnings.push(
					new WebpackError(
						`Conflict: Multiple assets emit different content to the same filename ${file}`
					)
				);
				this.assets[file] = source;
				this.assetsInfo.set(file, assetInfo);
				return;
			}
			const oldInfo = this.assetsInfo.get(file);
			this.assetsInfo.set(file, Object.assign({}, oldInfo, assetInfo));
			return;
		}
		this.assets[file] = source;
		this.assetsInfo.set(file, assetInfo);
	}

	/**
	 * @param {string} file file name
	 * @param {Source | function(Source): Source} newSourceOrFunction new asset source or function converting old to new
	 * @param {AssetInfo | function(AssetInfo | undefined): AssetInfo} assetInfoUpdateOrFunction new asset info or function converting old to new
	 */
	updateAsset(
		file,
		newSourceOrFunction,
		assetInfoUpdateOrFunction = undefined
	) {
		if (!this.assets[file]) {
			throw new Error(
				`Called Compilation.updateAsset for not existing filename ${file}`
			);
		}
		if (typeof newSourceOrFunction === "function") {
			this.assets[file] = newSourceOrFunction(this.assets[file]);
		} else {
			this.assets[file] = newSourceOrFunction;
		}
		if (assetInfoUpdateOrFunction !== undefined) {
			const oldInfo = this.assetsInfo.get(file);
			if (typeof assetInfoUpdateOrFunction === "function") {
				this.assetsInfo.set(file, assetInfoUpdateOrFunction(oldInfo || {}));
			} else {
				this.assetsInfo.set(
					file,
					Object.assign({}, oldInfo, assetInfoUpdateOrFunction)
				);
			}
		}
	}

	getAssets() {
		/** @type {Asset[]} */
		const array = [];
		for (const assetName of Object.keys(this.assets)) {
			if (Object.prototype.hasOwnProperty.call(this.assets, assetName)) {
				array.push({
					name: assetName,
					source: this.assets[assetName],
					info: this.assetsInfo.get(assetName) || {}
				});
			}
		}
		return array;
	}

	/**
	 * @param {string} name the name of the asset
	 * @returns {Asset | undefined} the asset or undefined when not found
	 */
	getAsset(name) {
		if (!Object.prototype.hasOwnProperty.call(this.assets, name))
			return undefined;
		return {
			name,
			source: this.assets[name],
			info: this.assetsInfo.get(name) || {}
		};
	}

	clearAssets() {
		for (const chunk of this.chunks) {
			chunk.files.clear();
			chunk.auxiliaryFiles.clear();
		}
	}

	createModuleAssets() {
		const { chunkGraph } = this;
		for (const module of this.modules) {
			if (module.buildInfo.assets) {
				const assetsInfo = module.buildInfo.assetsInfo;
				for (const assetName of Object.keys(module.buildInfo.assets)) {
					const fileName = this.getPath(assetName, {
						chunkGraph: this.chunkGraph,
						module
					});
					for (const chunk of chunkGraph.getModuleChunksIterable(module)) {
						chunk.auxiliaryFiles.add(fileName);
					}
					this.emitAsset(
						fileName,
						module.buildInfo.assets[assetName],
						assetsInfo ? assetsInfo.get(assetName) : undefined
					);
					this.hooks.moduleAsset.call(module, fileName);
				}
			}
		}
	}

	/**
	 * @param {RenderManifestOptions} options options object
	 * @returns {RenderManifestEntry[]} manifest entries
	 */
	getRenderManifest(options) {
		return this.hooks.renderManifest.call([], options);
	}

	/**
	 * @param {Callback} callback signals when the call finishes
	 * @returns {void}
	 */
	createChunkAssets(callback) {
		const outputOptions = this.outputOptions;
		const cachedSourceMap = new WeakMap();
		/** @type {Map<string, {hash: string, source: Source, chunk: Chunk}>} */
		const alreadyWrittenFiles = new Map();

		asyncLib.forEach(
			this.chunks,
			(chunk, callback) => {
				/** @type {RenderManifestEntry[]} */
				let manifest;
				try {
					manifest = this.getRenderManifest({
						chunk,
						hash: this.hash,
						fullHash: this.fullHash,
						outputOptions,
						codeGenerationResults: this.codeGenerationResults,
						moduleTemplates: this.moduleTemplates,
						dependencyTemplates: this.dependencyTemplates,
						chunkGraph: this.chunkGraph,
						moduleGraph: this.moduleGraph,
						runtimeTemplate: this.runtimeTemplate
					});
				} catch (err) {
					this.errors.push(new ChunkRenderError(chunk, "", err));
					return callback();
				}
				asyncLib.forEach(
					manifest,
					(fileManifest, callback) => {
						const ident = fileManifest.identifier;
						const cacheName = `${this.compilerPath}/asset/${ident}`;
						const usedHash = fileManifest.hash;

						this.cache.get(cacheName, usedHash, (err, sourceFromCache) => {
							/** @type {string | function(PathData, AssetInfo=): string} */
							let filenameTemplate;
							/** @type {string} */
							let file;

							let inTry = true;
							const errorAndCallback = err => {
								const filename =
									file ||
									(typeof filenameTemplate === "string"
										? filenameTemplate
										: "");

								this.errors.push(new ChunkRenderError(chunk, filename, err));
								inTry = false;
								return callback();
							};

							try {
								filenameTemplate = fileManifest.filenameTemplate;
								const pathAndInfo = this.getPathWithInfo(
									filenameTemplate,
									fileManifest.pathOptions
								);
								file = pathAndInfo.path;
								const assetInfo = pathAndInfo.info;

								if (err) {
									return errorAndCallback(err);
								}

								let source = sourceFromCache;

								// check if the same filename was already written by another chunk
								const alreadyWritten = alreadyWrittenFiles.get(file);
								if (alreadyWritten !== undefined) {
									if (alreadyWritten.hash !== usedHash) {
										inTry = false;
										return callback(
											new WebpackError(
												`Conflict: Multiple chunks emit assets to the same filename ${file}` +
													` (chunks ${alreadyWritten.chunk.id} and ${chunk.id})`
											)
										);
									} else {
										source = alreadyWritten.source;
									}
								} else if (!source) {
									// render the asset
									source = fileManifest.render();

									// Ensure that source is a cached source to avoid additional cost because of repeated access
									if (!(source instanceof CachedSource)) {
										const cacheEntry = cachedSourceMap.get(source);
										if (cacheEntry) {
											source = cacheEntry;
										} else {
											const cachedSource = new CachedSource(source);
											cachedSourceMap.set(source, cachedSource);
											source = cachedSource;
										}
									}
								}
								this.emitAsset(file, source, assetInfo);
								if (fileManifest.auxiliary) {
									chunk.auxiliaryFiles.add(file);
								} else {
									chunk.files.add(file);
								}
								this.hooks.chunkAsset.call(chunk, file);
								alreadyWrittenFiles.set(file, {
									hash: usedHash,
									source,
									chunk
								});
								if (source !== sourceFromCache) {
									this.cache.store(cacheName, usedHash, source, err => {
										if (err) return errorAndCallback(err);
										return callback();
									});
								} else {
									inTry = false;
									callback();
								}
							} catch (err) {
								if (!inTry) throw err;
								errorAndCallback(err);
							}
						});
					},
					callback
				);
			},
			callback
		);
	}

	/**
	 * @param {string | function(PathData, AssetInfo=): string} filename used to get asset path with hash
	 * @param {PathData} data context data
	 * @returns {string} interpolated path
	 */
	getPath(filename, data = {}) {
		if (!data.hash) {
			data = {
				hash: this.hash,
				...data
			};
		}
		return this.getAssetPath(filename, data);
	}

	/**
	 * @param {string | function(PathData, AssetInfo=): string} filename used to get asset path with hash
	 * @param {PathData} data context data
	 * @returns {{ path: string, info: AssetInfo }} interpolated path and asset info
	 */
	getPathWithInfo(filename, data = {}) {
		if (!data.hash) {
			data = {
				hash: this.hash,
				...data
			};
		}
		return this.getAssetPathWithInfo(filename, data);
	}

	/**
	 * @param {string | function(PathData, AssetInfo=): string} filename used to get asset path with hash
	 * @param {PathData} data context data
	 * @returns {string} interpolated path
	 */
	getAssetPath(filename, data) {
		return this.hooks.assetPath.call(
			typeof filename === "function" ? filename(data) : filename,
			data,
			undefined
		);
	}

	/**
	 * @param {string | function(PathData, AssetInfo=): string} filename used to get asset path with hash
	 * @param {PathData} data context data
	 * @returns {{ path: string, info: AssetInfo }} interpolated path and asset info
	 */
	getAssetPathWithInfo(filename, data) {
		const assetInfo = {};
		// TODO webpack 5: refactor assetPath hook to receive { path, info } object
		const newPath = this.hooks.assetPath.call(
			typeof filename === "function" ? filename(data, assetInfo) : filename,
			data,
			assetInfo
		);
		return { path: newPath, info: assetInfo };
	}

	/**
	 * This function allows you to run another instance of webpack inside of webpack however as
	 * a child with different settings and configurations (if desired) applied. It copies all hooks, plugins
	 * from parent (or top level compiler) and creates a child Compilation
	 *
	 * @param {string} name name of the child compiler
	 * @param {OutputOptions} outputOptions // Need to convert config schema to types for this
	 * @param {Plugin[]} plugins webpack plugins that will be applied
	 * @returns {Compiler} creates a child Compiler instance
	 */
	createChildCompiler(name, outputOptions, plugins) {
		const idx = this.childrenCounters[name] || 0;
		this.childrenCounters[name] = idx + 1;
		return this.compiler.createChildCompiler(
			this,
			name,
			idx,
			outputOptions,
			plugins
		);
	}

	checkConstraints() {
		const chunkGraph = this.chunkGraph;

		/** @type {Set<number|string>} */
		const usedIds = new Set();

		for (const module of this.modules) {
			if (module.type === "runtime") continue;
			const moduleId = chunkGraph.getModuleId(module);
			if (moduleId === null) continue;
			if (usedIds.has(moduleId)) {
				throw new Error(`checkConstraints: duplicate module id ${moduleId}`);
			}
			usedIds.add(moduleId);
		}

		for (const chunk of this.chunks) {
			for (const module of chunkGraph.getChunkModulesIterable(chunk)) {
				if (!this.modules.has(module)) {
					throw new Error(
						"checkConstraints: module in chunk but not in compilation " +
							` ${chunk.debugId} ${module.debugId}`
					);
				}
			}
			for (const module of chunkGraph.getChunkEntryModulesIterable(chunk)) {
				if (!this.modules.has(module)) {
					throw new Error(
						"checkConstraints: entry module in chunk but not in compilation " +
							` ${chunk.debugId} ${module.debugId}`
					);
				}
			}
		}

		for (const chunkGroup of this.chunkGroups) {
			chunkGroup.checkConstraints();
		}
	}
}

module.exports = Compilation;
