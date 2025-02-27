/**
 * The following code is modified based on
 * https://github.com/webpack/webpack/blob/4b4ca3b/lib
 *
 * MIT Licensed
 * Author Tobias Koppers @sokra
 * Copyright (c) JS Foundation and other contributors
 * https://github.com/webpack/webpack/blob/main/LICENSE
 */
import {
	getNormalizedRspackOptions,
	RspackOptions,
	applyRspackOptionsBaseDefaults,
	applyRspackOptionsDefaults,
	RspackPluginFunction
} from "./config";
import { Compiler } from "./compiler";
import { Stats } from "./stats";
import util from "util";

import { RspackOptionsApply } from "./rspackOptionsApply";
import NodeEnvironmentPlugin from "./node/NodeEnvironmentPlugin";
import {
	MultiCompiler,
	MultiCompilerOptions,
	MultiRspackOptions
} from "./multiCompiler";
import { Callback } from "tapable";
import MultiStats from "./multiStats";
import assert from "assert";
import { asArray, isNil } from "./util";
import rspackOptionsCheck from "./config/schema.check.js";
import InvalidateConfigurationError from "./error/InvalidateConfiguration";
import { validate, ValidationError } from "schema-utils";
import IgnoreWarningsPlugin from "./lib/ignoreWarningsPlugin";

function createMultiCompiler(options: MultiRspackOptions): MultiCompiler {
	const compilers = options.map(createCompiler);
	const compiler = new MultiCompiler(
		compilers,
		options as MultiCompilerOptions
	);
	for (const childCompiler of compilers) {
		if (childCompiler.options.dependencies) {
			compiler.setDependencies(
				childCompiler,
				childCompiler.options.dependencies
			);
		}
	}

	return compiler;
}

function createCompiler(userOptions: RspackOptions): Compiler {
	const options = getNormalizedRspackOptions(userOptions);
	applyRspackOptionsBaseDefaults(options);
	assert(!isNil(options.context));
	const compiler = new Compiler(options.context, options);

	new NodeEnvironmentPlugin({
		infrastructureLogging: options.infrastructureLogging
	}).apply(compiler);

	const logger = compiler.getInfrastructureLogger("config");
	logger.debug(
		"RawOptions:",
		util.inspect(userOptions, { colors: true, depth: null })
	);

	if (Array.isArray(options.plugins)) {
		for (const plugin of options.plugins) {
			if (typeof plugin === "function") {
				(plugin as RspackPluginFunction).call(compiler, compiler);
			} else {
				plugin.apply(compiler);
			}
		}
	}

	if (options.ignoreWarnings !== undefined) {
		new IgnoreWarningsPlugin(options.ignoreWarnings).apply(compiler);
	}

	applyRspackOptionsDefaults(compiler.options);
	logger.debug(
		"NormalizedOptions:",
		util.inspect(compiler.options, { colors: true, depth: null })
	);
	compiler.hooks.environment.call();
	compiler.hooks.afterEnvironment.call();
	new RspackOptionsApply().process(compiler.options, compiler);
	compiler.hooks.initialize.call();
	return compiler;
}

function isMultiRspackOptions(o: unknown): o is MultiRspackOptions {
	return Array.isArray(o);
}

function revalidateWithStrategy(options: RspackOptions | MultiRspackOptions) {
	try {
		validate(require("./config/schema.js"), options);
	} catch (e) {
		if (!(e instanceof ValidationError)) {
			throw e;
		}
		// 'strict', 'loose', 'loose-silent'
		const strategy = process.env.RSPACK_CONFIG_VALIDATE ?? "strict";
		if (strategy === "loose-silent") return;
		if (strategy === "loose") {
			console.error(e.message);
			return;
		}
		throw new InvalidateConfigurationError(e.message);
	}
}

function rspack(
	options: MultiRspackOptions,
	callback?: Callback<Error, MultiStats>
): MultiCompiler;
function rspack(
	options: RspackOptions,
	callback?: Callback<Error, Stats>
): Compiler;
function rspack(
	options: MultiRspackOptions | RspackOptions,
	callback?: Callback<Error, MultiStats | Stats>
): MultiCompiler | Compiler;
function rspack(
	options: MultiRspackOptions | RspackOptions,
	callback?: Callback<Error, MultiStats> | Callback<Error, Stats>
) {
	if (!asArray(options).every(i => rspackOptionsCheck(i))) {
		// slow path
		revalidateWithStrategy(options);
	}
	const create = () => {
		if (isMultiRspackOptions(options)) {
			const compiler = createMultiCompiler(options);
			const watch = options.some(options => options.watch);
			const watchOptions = options.map(options => options.watchOptions || {});
			return { compiler, watch, watchOptions };
		}
		const compiler = createCompiler(options);
		const watch = options.watch;
		const watchOptions = options.watchOptions || {};
		return { compiler, watch, watchOptions };
	};

	if (callback) {
		try {
			const { compiler, watch, watchOptions } = create();
			if (watch) {
				compiler.watch(watchOptions as any, callback as any);
			} else {
				compiler.run((err, stats) => {
					compiler.close(() => {
						callback(err, stats as any);
					});
				});
			}
			return compiler;
		} catch (err: any) {
			process.nextTick(() => callback(err));
			return null;
		}
	} else {
		const { compiler, watch } = create();
		if (watch) {
			util.deprecate(() => {},
			"A 'callback' argument needs to be provided to the 'rspack(options, callback)' function when the 'watch' option is set. There is no way to handle the 'watch' option without a callback.")();
		}
		return compiler;
	}
}

// deliberately alias rspack as webpack
export { rspack, createCompiler, createMultiCompiler };
export default rspack;
