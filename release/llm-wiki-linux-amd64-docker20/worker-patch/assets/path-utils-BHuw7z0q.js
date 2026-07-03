//#region src/lib/path-utils.ts
/**
* Normalize a path to use forward slashes (works on both macOS and Windows).
* Windows APIs accept forward slashes, so normalizing to / is safe everywhere.
*/
function normalizePath(p) {
	return p.replace(/\\/g, "/");
}
/**
* Get the filename from a path (handles both / and \).
*/
function getFileName(p) {
	return p.replace(/\\/g, "/").split("/").pop() ?? p;
}
/**
* Cross-platform absolute-path detection.
*
* Unix:     "/foo/bar"
* Windows:  "C:\foo", "C:/foo", "\\server\share", "//server/share"
*
* A bare `.startsWith("/")` check wrongly treats Windows paths like
* "C:/project/file.pdf" as relative, which produced double-joined
* garbage like "C:/project/C:/project/file.pdf" in the ingest queue.
*/
function isAbsolutePath(p) {
	if (!p) return false;
	if (p.startsWith("/")) return true;
	if (/^[A-Za-z]:[\\/]/.test(p)) return true;
	if (p.startsWith("\\\\") || p.startsWith("//")) return true;
	return false;
}
//#endregion
export { getFileName, isAbsolutePath, normalizePath };
