//#region src/lib/logger.ts
var LEVEL_ORDER = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3
};
var consoleSink = {
	name: "console",
	write(entry) {
		const prefix = `[${entry.namespace}]`;
		const args = entry.meta ? [
			prefix,
			entry.message,
			entry.meta
		] : [prefix, entry.message];
		switch (entry.level) {
			case "debug":
				console.debug(...args);
				break;
			case "info":
				console.info(...args);
				break;
			case "warn":
				console.warn(...args);
				break;
			case "error":
				console.error(...args);
				break;
		}
	}
};
var RING_MAX = 500;
var _ringCounter = 0;
var _ring = [];
var _ringListeners = /* @__PURE__ */ new Set();
var ringBufferSink = {
	name: "ring",
	write(entry) {
		if (_ring.length >= RING_MAX) _ring.shift();
		_ring.push({
			...entry,
			id: ++_ringCounter
		});
		_ringListeners.forEach((cb) => cb());
	}
};
var _globalLevel = "info";
var _namespaceOverrides = /* @__PURE__ */ new Map();
var _sinks = [consoleSink, ringBufferSink];
function effectiveLevel(namespace) {
	if (_namespaceOverrides.has(namespace)) return _namespaceOverrides.get(namespace);
	let best;
	let bestLen = -1;
	for (const [ns, lv] of _namespaceOverrides) if (namespace.startsWith(ns) && ns.length > bestLen) {
		best = lv;
		bestLen = ns.length;
	}
	return best ?? _globalLevel;
}
function dispatch(entry) {
	const minOrder = LEVEL_ORDER[effectiveLevel(entry.namespace)];
	if (LEVEL_ORDER[entry.level] < minOrder) return;
	for (const sink of _sinks) {
		if (sink.filter && !sink.filter(entry)) continue;
		try {
			sink.write(entry);
		} catch {}
	}
}
function makeLogger(namespace) {
	function log(level, message, meta) {
		dispatch({
			timestamp: (/* @__PURE__ */ new Date()).toISOString(),
			namespace,
			level,
			message,
			meta
		});
	}
	return {
		namespace,
		debug: (msg, meta) => log("debug", msg, meta),
		info: (msg, meta) => log("info", msg, meta),
		warn: (msg, meta) => log("warn", msg, meta),
		error: (msg, meta) => log("error", msg, meta),
		child: (sub) => makeLogger(`${namespace}:${sub}`)
	};
}
var _loggers = /* @__PURE__ */ new Map();
/**
* Get (or create) a namespaced logger.
* @example
*   const log = getLogger("ingest:ocr")
*   log.info("OCR complete", { pages: 12, chars: 4500 })
*/
function getLogger(namespace) {
	if (!_loggers.has(namespace)) _loggers.set(namespace, makeLogger(namespace));
	return _loggers.get(namespace);
}
//#endregion
export { getLogger as t };
