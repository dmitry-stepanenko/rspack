/**
 * The following code is modified based on
 * https://github.com/webpack/loader-runner
 *
 * MIT Licensed
 * Author Tobias Koppers @sokra
 * Copyright (c) JS Foundation and other contributors
 * https://github.com/webpack/loader-runner/blob/main/LICENSE
 */

import { JsLoaderContext } from "@rspack/binding";
import {
	OriginalSource,
	RawSource,
	Source,
	SourceMapSource
} from "webpack-sources";

import { Compiler } from "../compiler";
import { NormalModule } from "../normalModule";
import { Compilation } from "../compilation";
import {
	LoaderContext,
	LoaderObject,
	isUseSimpleSourceMap,
	isUseSourceMap
} from "../config/adapter-rule-use";
import { concatErrorMsgAndStack, isNil, toBuffer, toObject } from "../util";
import { absolutify, contextify, makePathsRelative } from "../util/identifier";
import { memoize } from "../util/memoize";
import { createHash } from "../util/createHash";
import loadLoader = require("./loadLoader");

const PATH_QUERY_FRAGMENT_REGEXP =
	/^((?:\0.|[^?#\0])*)(\?(?:\0.|[^#\0])*)?(#.*)?$/;

export function parsePathQueryFragment(str: string): {
	path: string;
	query: string;
	fragment: string;
} {
	let match = PATH_QUERY_FRAGMENT_REGEXP.exec(str);
	return {
		path: match?.[1].replace(/\0(.)/g, "$1") || "",
		query: match?.[2] ? match[2].replace(/\0(.)/g, "$1") : "",
		fragment: match?.[3] || ""
	};
}

function dirname(path: string) {
	if (path === "/") return "/";
	var i = path.lastIndexOf("/");
	var j = path.lastIndexOf("\\");
	var i2 = path.indexOf("/");
	var j2 = path.indexOf("\\");
	var idx = i > j ? i : j;
	var idx2 = i > j ? i2 : j2;
	if (idx < 0) return path;
	if (idx === idx2) return path.slice(0, idx + 1);
	return path.slice(0, idx);
}

function stringifyLoaderObject(o: LoaderObject): string {
	return o.path + o.query + o.fragment;
}

function createLoaderObject(loader: any, compiler: Compiler): LoaderObject {
	const obj: any = {
		path: null,
		query: null,
		fragment: null,
		options: null,
		ident: null,
		normal: null,
		pitch: null,
		raw: null,
		data: null,
		pitchExecuted: false,
		normalExecuted: false
	};
	Object.defineProperty(obj, "request", {
		enumerable: true,
		get: function () {
			return (
				obj.path.replace(/#/g, "\0#") +
				obj.query.replace(/#/g, "\0#") +
				obj.fragment
			);
		},
		set: function (value) {
			if (typeof value === "string") {
				let splittedRequest = parsePathQueryFragment(value);
				obj.path = splittedRequest.path;
				obj.query = splittedRequest.query;
				obj.fragment = splittedRequest.fragment;

				if (obj.query.startsWith("??")) {
					const ident = obj.query.slice(2);
					if (ident === "[[missing ident]]") {
						throw new Error(
							"No ident is provided by referenced loader. " +
								"When using a function for Rule.use in config you need to " +
								"provide an 'ident' property for referenced loader options."
						);
					}
					obj.options = compiler.ruleSet.references.get(ident);
					if (obj.options === undefined) {
						throw new Error("Invalid ident is provided by referenced loader");
					}
					obj.ident = ident;
				} else {
					obj.options = undefined;
					obj.ident = undefined;
				}
			} else {
				if (!value.loader)
					throw new Error(
						"request should be a string or object with loader and options (" +
							JSON.stringify(value) +
							")"
					);
				obj.path = value.loader;
				obj.fragment = value.fragment || "";
				obj.type = value.type;
				obj.options = value.options;
				obj.ident = value.ident;
				if (obj.options === null) obj.query = "";
				else if (obj.options === undefined) obj.query = "";
				else if (typeof obj.options === "string") obj.query = "?" + obj.options;
				else if (obj.ident) obj.query = "??" + obj.ident;
				else if (typeof obj.options === "object" && obj.options.ident)
					obj.query = "??" + obj.options.ident;
				else obj.query = "?" + JSON.stringify(obj.options);
			}
		}
	});
	obj.request = loader;
	if (Object.preventExtensions) {
		Object.preventExtensions(obj);
	}
	return obj;
}

function getCurrentLoader(
	loaderContext: LoaderContext,
	index = loaderContext.loaderIndex
) {
	if (
		loaderContext.loaders &&
		loaderContext.loaders.length &&
		index < loaderContext.loaders.length &&
		index >= 0 &&
		loaderContext.loaders[index]
	) {
		return loaderContext.loaders[index];
	}
	return null;
}

export async function runLoader(
	rawContext: JsLoaderContext,
	compiler: Compiler
) {
	const resource = rawContext.resource;
	const loaderContext: LoaderContext = {} as LoaderContext;

	//
	const splittedResource = parsePathQueryFragment(resource);
	const resourcePath = splittedResource.path;
	const resourceQuery = splittedResource.query;
	const resourceFragment = splittedResource.fragment;
	const contextDirectory = dirname(resourcePath);

	// execution state
	let isPitching = rawContext.isPitching;
	let cacheable = true;
	let fileDependencies: string[] = rawContext.fileDependencies.slice();
	let contextDependencies: string[] = rawContext.contextDependencies.slice();
	let missingDependencies: string[] = rawContext.missingDependencies.slice();
	let buildDependencies: string[] = rawContext.buildDependencies.slice();
	let assetFilenames = rawContext.assetFilenames.slice();

	const loaders = rawContext.currentLoader
		.split("$")
		.map(loader => createLoaderObject(loader, compiler));

	loaderContext.__internal__isPitching = isPitching;
	loaderContext.context = contextDirectory;
	loaderContext.loaderIndex = 0;
	loaderContext.loaders = loaders;
	loaderContext.resourcePath = resourcePath;
	loaderContext.resourceQuery = resourceQuery;
	loaderContext.resourceFragment = resourceFragment;
	loaderContext.cacheable = function (flag) {
		if (flag === false) {
			cacheable = false;
		}
	};
	loaderContext.dependency = loaderContext.addDependency =
		function addDependency(file) {
			fileDependencies.push(file);
		};
	loaderContext.addContextDependency = function addContextDependency(context) {
		contextDependencies.push(context);
	};
	loaderContext.addMissingDependency = function addMissingDependency(context) {
		missingDependencies.push(context);
	};
	loaderContext.getDependencies = function getDependencies() {
		return fileDependencies.slice();
	};
	loaderContext.getContextDependencies = function getContextDependencies() {
		return contextDependencies.slice();
	};
	loaderContext.getMissingDependencies = function getMissingDependencies() {
		return missingDependencies.slice();
	};
	loaderContext.clearDependencies = function clearDependencies() {
		fileDependencies.length = 0;
		contextDependencies.length = 0;
		missingDependencies.length = 0;
		cacheable = true;
	};
	Object.defineProperty(loaderContext, "resource", {
		enumerable: true,
		get: function () {
			if (loaderContext.resourcePath === undefined) return undefined;
			return (
				loaderContext.resourcePath.replace(/#/g, "\0#") +
				loaderContext.resourceQuery.replace(/#/g, "\0#") +
				loaderContext.resourceFragment
			);
		},
		set: function (value) {
			var splittedResource = value && parsePathQueryFragment(value);
			loaderContext.resourcePath = splittedResource
				? splittedResource.path
				: undefined;
			loaderContext.resourceQuery = splittedResource
				? splittedResource.query
				: undefined;
			loaderContext.resourceFragment = splittedResource
				? splittedResource.fragment
				: undefined;
		}
	});
	Object.defineProperty(loaderContext, "request", {
		enumerable: true,
		get: function () {
			return loaderContext.loaders
				.map(function (o) {
					return o.request;
				})
				.concat(loaderContext.resource || "")
				.join("!");
		}
	});
	Object.defineProperty(loaderContext, "remainingRequest", {
		enumerable: true,
		get: function () {
			if (
				loaderContext.loaderIndex >= loaderContext.loaders.length - 1 &&
				!loaderContext.resource
			)
				return "";
			return loaderContext.loaders
				.slice(loaderContext.loaderIndex + 1)
				.map(function (o) {
					return o.request;
				})
				.concat(loaderContext.resource || "")
				.join("!");
		}
	});
	Object.defineProperty(loaderContext, "currentRequest", {
		enumerable: true,
		get: function () {
			return loaderContext.loaders
				.slice(loaderContext.loaderIndex)
				.map(function (o) {
					return o.request;
				})
				.concat(loaderContext.resource || "")
				.join("!");
		}
	});
	Object.defineProperty(loaderContext, "previousRequest", {
		enumerable: true,
		get: function () {
			return loaderContext.loaders
				.slice(0, loaderContext.loaderIndex)
				.map(function (o) {
					return o.request;
				})
				.join("!");
		}
	});
	Object.defineProperty(loaderContext, "query", {
		enumerable: true,
		get: function () {
			var entry = loaderContext.loaders[loaderContext.loaderIndex];
			return entry.options && typeof entry.options === "object"
				? entry.options
				: entry.query;
		}
	});
	Object.defineProperty(loaderContext, "data", {
		enumerable: true,
		get: function () {
			return loaderContext.loaders[loaderContext.loaderIndex].data;
		}
	});
	loaderContext.version = 2;
	loaderContext.sourceMap = compiler.options.devtool
		? isUseSourceMap(compiler.options.devtool)
		: false;
	loaderContext.mode = compiler.options.mode;
	loaderContext.hot = compiler.options.devServer?.hot;

	const getResolveContext = () => {
		// FIXME: resolve's fileDependencies will includes lots of dir, '/', etc
		return {
			fileDependencies: {
				// @ts-expect-error
				add: d => {
					// loaderContext.addDependency(d)
				}
			},
			contextDependencies: {
				// @ts-expect-error
				add: d => {
					// loaderContext.addContextDependency(d)
				}
			},
			missingDependencies: {
				// @ts-expect-error
				add: d => {
					// loaderContext.addMissingDependency(d)
				}
			}
		};
	};

	const resolver = compiler.resolverFactory.get("normal");
	loaderContext.resolve = function resolve(context, request, callback) {
		resolver.resolve({}, context, request, getResolveContext(), callback);
	};
	// @ts-expect-error TODO
	loaderContext.getResolve = function getResolve(options) {
		const child = options ? resolver.withOptions(options) : resolver;
		return (context, request, callback) => {
			if (callback) {
				child.resolve({}, context, request, getResolveContext(), callback);
			} else {
				return new Promise((resolve, reject) => {
					child.resolve(
						{},
						context,
						request,
						getResolveContext(),
						(err, result) => {
							if (err) reject(err);
							else resolve(result);
						}
					);
				});
			}
		};
	};
	loaderContext.getLogger = function getLogger(name) {
		return compiler.getInfrastructureLogger(() =>
			[name, resource].filter(Boolean).join("|")
		);
	};
	loaderContext.rootContext = compiler.context;
	loaderContext.emitError = function emitError(error) {
		const title = "Module Error";
		const message =
			error instanceof Error ? concatErrorMsgAndStack(error) : error;
		compiler.compilation.pushDiagnostic(
			"error",
			title,
			`${message}\n(from: ${stringifyLoaderObject(
				loaderContext.loaders[loaderContext.loaderIndex]
			)})`
		);
	};
	loaderContext.emitWarning = function emitWarning(warning) {
		const title = "Module Warning";
		const message =
			warning instanceof Error ? concatErrorMsgAndStack(warning) : warning;
		compiler.compilation.pushDiagnostic(
			"warning",
			title,
			`${message}\n(from: ${stringifyLoaderObject(
				loaderContext.loaders[loaderContext.loaderIndex]
			)})`
		);
	};
	loaderContext.emitFile = function emitFile(
		name,
		content,
		sourceMap?,
		assetInfo?
	) {
		let source: Source;
		if (sourceMap) {
			if (
				typeof sourceMap === "string" &&
				(loaderContext.sourceMap ||
					(compiler.options.devtool &&
						isUseSimpleSourceMap(compiler.options.devtool)))
			) {
				source = new OriginalSource(
					content,
					makePathsRelative(contextDirectory, sourceMap, compiler)
				);
			}

			if (this.sourceMap) {
				source = new SourceMapSource(
					// @ts-expect-error webpack-sources type declaration is wrong
					content,
					name,
					makePathsRelative(contextDirectory, sourceMap, compiler)
				);
			}
		} else {
			source = new RawSource(
				// @ts-expect-error webpack-sources type declaration is wrong
				content
			);
		}
		assetFilenames.push(name),
			// @ts-expect-error
			compiler.compilation.emitAsset(name, source, assetInfo);
	};
	loaderContext.fs = compiler.inputFileSystem;

	const getAbsolutify = memoize(() => absolutify.bindCache(compiler.root));
	const getAbsolutifyInContext = memoize(() =>
		absolutify.bindContextCache(contextDirectory, compiler.root)
	);
	const getContextify = memoize(() => contextify.bindCache(compiler.root));
	const getContextifyInContext = memoize(() =>
		contextify.bindContextCache(contextDirectory, compiler.root)
	);

	loaderContext.utils = {
		absolutify: (context, request) => {
			return context === contextDirectory
				? getAbsolutifyInContext()(request)
				: getAbsolutify()(context, request);
		},
		contextify: (context, request) => {
			return context === contextDirectory
				? getContextifyInContext()(request)
				: getContextify()(context, request);
		},
		createHash: type => {
			return createHash(
				type || compiler.compilation.outputOptions.hashFunction
			);
		}
	};
	loaderContext.addBuildDependency = function addBuildDependency(file) {
		buildDependencies.push(file);
	};
	loaderContext.addDependency = function addDependency(file) {
		fileDependencies.push(file);
	};
	loaderContext.dependency = function dependency(file) {
		fileDependencies.push(file);
	};
	loaderContext.addContextDependency = function addContextDependency(context) {
		contextDependencies.push(context);
	};
	loaderContext.addMissingDependency = function addMissingDependency(missing) {
		missingDependencies.push(missing);
	};
	loaderContext.clearDependencies = function clearDependencies() {
		fileDependencies.length = 0;
		contextDependencies.length = 0;
		missingDependencies.length = 0;
	};
	loaderContext.getDependencies = function getDependencies() {
		return fileDependencies.slice();
	};
	loaderContext.getContextDependencies = function getContextDependencies() {
		return contextDependencies.slice();
	};
	loaderContext.getMissingDependencies = function getMissingDependencies() {
		return missingDependencies.slice();
	};
	loaderContext._compiler = compiler;
	loaderContext._compilation = compiler.compilation;
	loaderContext.getOptions = function (schema) {
		let loader = getCurrentLoader(loaderContext);
		let options = loader?.options;

		if (options === null || options === undefined) {
			options = {};
		}

		if (schema) {
			let name = "Loader";
			let baseDataPath = "options";
			let match;
			if (schema.title && (match = /^(.+) (.+)$/.exec(schema.title))) {
				[, name, baseDataPath] = match;
			}
			const { validate } = require("schema-utils");
			validate(schema, options, {
				name,
				baseDataPath
			});
		}
		return options;
	};

	let compilation: Compilation | undefined = compiler.compilation;
	let step = 0;
	while (compilation) {
		NormalModule.getCompilationHooks(compilation).loader.call(loaderContext);
		compilation = compilation.compiler.parentCompilation;
		step++;
		if (step > 1000) {
			throw Error(
				"Too many nested child compiler, exceeded max limitation 1000"
			);
		}
	}

	return new Promise((resolve, reject) => {
		if (isPitching) {
			iteratePitchingLoaders(loaderContext, [], (err: Error, result: any[]) => {
				if (err) {
					return reject(err);
				}
				const [content, sourceMap, additionalData] = result;
				resolve({
					content: isNil(content) ? undefined : toBuffer(content),
					sourceMap: isNil(sourceMap)
						? undefined
						: toBuffer(
								typeof sourceMap === "string"
									? sourceMap
									: JSON.stringify(sourceMap)
						  ),
					additionalData: isNil(additionalData)
						? undefined
						: toBuffer(JSON.stringify(additionalData)),
					buildDependencies,
					cacheable,
					fileDependencies,
					contextDependencies,
					missingDependencies,
					assetFilenames,
					isPitching: loaderContext.__internal__isPitching
				});
			});
		} else {
			// normal
			loaderContext.loaderIndex = loaderContext.loaders.length - 1;
			iterateNormalLoaders(
				loaderContext,
				[
					rawContext.content,
					isNil(rawContext.sourceMap)
						? undefined
						: toObject(rawContext.sourceMap),
					isNil(rawContext.additionalData)
						? undefined
						: toObject(rawContext.additionalData)
				],
				(err: Error, result: any[]) => {
					if (err) {
						return reject(err);
					}
					const [content, sourceMap, additionalData] = result;
					resolve({
						content: isNil(content) ? undefined : toBuffer(content),
						sourceMap: isNil(sourceMap)
							? undefined
							: toBuffer(
									typeof sourceMap === "string"
										? sourceMap
										: JSON.stringify(sourceMap)
							  ),
						additionalData: isNil(additionalData)
							? undefined
							: toBuffer(JSON.stringify(additionalData)),
						buildDependencies,
						cacheable,
						fileDependencies,
						contextDependencies,
						missingDependencies,
						assetFilenames,
						isPitching: loaderContext.__internal__isPitching
					});
				}
			);
		}
	});
}

function utf8BufferToString(buf: Buffer) {
	var str = buf.toString("utf-8");
	if (str.charCodeAt(0) === 0xfeff) {
		return str.slice(1);
	} else {
		return str;
	}
}

function convertArgs(args: any[], raw: boolean) {
	if (!raw && Buffer.isBuffer(args[0])) args[0] = utf8BufferToString(args[0]);
	else if (raw && typeof args[0] === "string")
		args[0] = Buffer.from(args[0], "utf-8");
}

function runSyncOrAsync(
	fn: Function,
	context: LoaderContext,
	args: any[],
	callback: Function
) {
	var isSync = true;
	var isDone = false;
	var isError = false; // internal error
	var reportedError = false;
	// @ts-expect-error loader-runner leverages `arguments` to achieve the same functionality.
	context.async = function async() {
		if (isDone) {
			if (reportedError) return; // ignore
			throw new Error("async(): The callback was already called.");
		}
		isSync = false;
		return innerCallback;
	};
	var innerCallback = (context.callback = function () {
		if (isDone) {
			if (reportedError) return; // ignore
			throw new Error("callback(): The callback was already called.");
		}
		isDone = true;
		isSync = false;
		try {
			callback.apply(null, arguments);
		} catch (e) {
			isError = true;
			throw e;
		}
	});
	try {
		var result = (function LOADER_EXECUTION() {
			return fn.apply(context, args);
		})();
		if (isSync) {
			isDone = true;
			if (result === undefined) return callback();
			if (
				result &&
				typeof result === "object" &&
				typeof result.then === "function"
			) {
				return result.then(function (r: unknown) {
					callback(null, r);
				}, callback);
			}
			return callback(null, result);
		}
	} catch (e: unknown) {
		if (isError) throw e;
		if (isDone) {
			// loader is already "done", so we cannot use the callback function
			// for better debugging we print the error on the console
			if (e instanceof Error) console.error(e.stack);
			else console.error(e);
			return;
		}
		isDone = true;
		reportedError = true;
		callback(e);
	}
}

function iteratePitchingLoaders(
	loaderContext: LoaderContext,
	args: any[],
	callback: Function
): void {
	// Running out of js loaders, so yield back to rust.
	// Directly callback as we may still have other loaders on the rust side,
	// The difference between rspack loader-runner and webpack loader-runner is
	// that we do not run the loaders in the normal stage if pitching is not successful.
	if (loaderContext.loaderIndex >= loaderContext.loaders.length)
		return callback(null, args);

	var currentLoaderObject = loaderContext.loaders[loaderContext.loaderIndex];

	// iterate
	if (currentLoaderObject.pitchExecuted) {
		loaderContext.loaderIndex++;
		return iteratePitchingLoaders(loaderContext, args, callback);
	}

	// load loader module
	loadLoader(currentLoaderObject, function (err: Error) {
		if (err) {
			loaderContext.cacheable(false);
			return callback(err);
		}
		var fn = currentLoaderObject.pitch;
		currentLoaderObject.pitchExecuted = true;

		if (!fn) return iteratePitchingLoaders(loaderContext, args, callback);

		runSyncOrAsync(
			fn,
			loaderContext,
			[
				loaderContext.remainingRequest,
				loaderContext.previousRequest,
				(currentLoaderObject.data = {})
			],
			function (err: Error) {
				if (err) return callback(err);
				var args = Array.prototype.slice.call(arguments, 1);
				// Determine whether to continue the pitching process based on
				// argument values (as opposed to argument presence) in order
				// to support synchronous and asynchronous usages.
				var hasArg = args.some(function (value) {
					return value !== undefined;
				});
				// If a loader pitched successfully,
				// then It should execute normal loaders too.
				if (hasArg) {
					// Instruct rust side to execute loaders in backwards.
					loaderContext.__internal__isPitching = false;
					loaderContext.loaderIndex--;
					iterateNormalLoaders(loaderContext, args, callback);
				} else {
					iteratePitchingLoaders(loaderContext, args, callback);
				}
			}
		);
	});
}

function iterateNormalLoaders(
	loaderContext: LoaderContext,
	args: any[],
	callback: Function
): void {
	// JS loaders ends
	if (loaderContext.loaderIndex < 0) return callback(null, args);

	var currentLoaderObject = loaderContext.loaders[loaderContext.loaderIndex];

	// iterate
	if (currentLoaderObject.normalExecuted) {
		loaderContext.loaderIndex--;
		return iterateNormalLoaders(loaderContext, args, callback);
	}

	loadLoader(currentLoaderObject, function (err: Error) {
		if (err) {
			loaderContext.cacheable(false);
			return callback(err);
		}

		var fn = currentLoaderObject.normal;
		currentLoaderObject.normalExecuted = true;
		if (!fn) {
			return iterateNormalLoaders(loaderContext, args, callback);
		}

		convertArgs(args, !!currentLoaderObject.raw);

		runSyncOrAsync(fn, loaderContext, args, function (err: Error) {
			if (err) return callback(err);

			var args = Array.prototype.slice.call(arguments, 1);
			iterateNormalLoaders(loaderContext, args, callback);
		});
	});
}
