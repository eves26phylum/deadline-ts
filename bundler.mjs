#!/usr/bin/env node
// roblox-ts Luau bundler — driven by default.project.json for all path resolution.
// Usage: node bundle.mjs   (run from your project root)

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const CWD = process.cwd();
const DIST_DIR = path.join(CWD, 'dist');
const DEADLINEOUT_DIR = path.join(CWD, 'deadlineout');

// ── Utilities ──────────────────────────────────────────────────────────────

/** Escape a string for use inside a Lua double-quoted string literal. */
function escLua(s) {
    return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Indent every non-blank line of `text` with `indent`.
 * Blank/whitespace-only lines are left as-is to avoid trailing whitespace.
 */
function indentLines(text, indent) {
    return text
        .split('\n')
        .map(line => (line.trim().length > 0 ? indent + line : line))
        .join('\n');
}

/**
 * Normalises a filesystem path string to a canonical forward-slash form with
 * no leading "./" and no trailing "/".  Used so that tsconfig outDir values
 * like "./out", "out/", ".\\out" all reduce to the same "out" before comparison
 * against $path values from project.json.
 */
function normaliseFsPath(p) {
    return p
        .replace(/\\/g, '/')
        .replace(/^\.\//, '')
        .replace(/\/$/, '');
}

/**
 * Minimal JSONC parser.  tsconfig.json files are JSONC — they allow line
 * comments (//), block comments (/* ... *\/), and trailing commas before
 * closing braces/brackets.  Node's JSON.parse rejects all of these.
 *
 * This stripper handles the common cases produced by VS Code / tsc tooling
 * without pulling in a full JSONC library dependency.
 */
function parseJsonc(text) {
    // Remove block comments first (non-greedy).
    let stripped = text.replace(/\/\*[\s\S]*?\*\//g, '');
    // Remove line comments. This is safe for tsconfig files in practice because
    // comments never appear mid-string in any tooling-generated tsconfig.
    stripped = stripped.replace(/\/\/[^\n]*/g, '');
    // Remove trailing commas before ] or } (JSON forbids them).
    stripped = stripped.replace(/,\s*([}\]])/g, '$1');
    return JSON.parse(stripped);
}

function readDogBuildConfigScripts() {
    const tsConfigPath = path.join(CWD, 'dog.json');

    if (!fs.existsSync(tsConfigPath)) {
        throw new Error(
            '[bundle] dog.json not found in project root. ' +
            'The bundler requires dog.json to determine the roblox-ts outDir.'
        );
    }

    const tsConfig = parseJsonc(fs.readFileSync(tsConfigPath, 'utf8'));

    const scripts = tsConfig?.scripts;
    if (!scripts) { 
        throw new Error("Scripts doesn't exist")
    }
    const buildScript = scripts?.build;
    if (!buildScript || typeof buildScript !== "string") {
        throw new Error("script is not a string");
    }
    return buildScript;
}
// ── tsconfig.json ──────────────────────────────────────────────────────────

/**
 * Reads tsconfig.json from the project root and returns the normalised outDir.
 *
 * Throws explicitly if the file is missing or if compilerOptions.outDir is not
 * set, because silently defaulting to "out" would mask misconfiguration and
 * cause the bundler to silently mis-classify or skip $path entries.
 */
function readTsConfigOutDir() {
    const tsConfigPath = path.join(CWD, 'tsconfig.json');

    if (!fs.existsSync(tsConfigPath)) {
        throw new Error(
            '[bundle] tsconfig.json not found in project root. ' +
            'The bundler requires tsconfig.json to determine the roblox-ts outDir.'
        );
    }

    const tsConfig = parseJsonc(fs.readFileSync(tsConfigPath, 'utf8'));

    const rawOutDir = tsConfig?.compilerOptions?.outDir;
    if (!rawOutDir || typeof rawOutDir !== 'string' || rawOutDir.trim() === '') {
        throw new Error(
            '[bundle] compilerOptions.outDir is missing or empty in tsconfig.json. ' +
            'roblox-ts requires an explicit outDir (e.g. "out") so the bundler can ' +
            'unambiguously identify the server/client/shared output directories.'
        );
    }

    return normaliseFsPath(rawOutDir);
}

// ── Project JSON ───────────────────────────────────────────────────────────

function readProjectJson() {
    const projectJsonPath = path.join(CWD, 'default.project.json');
    return JSON.parse(fs.readFileSync(projectJsonPath, 'utf8'));
}

/**
 * Recursively traverse the project.json tree, collecting every node that carries
 * a `$path` property along with its Roblox instance path and filesystem location.
 *
 * Nodes are pushed parent-first (before recursing into children), so a parent entry
 * always appears earlier in the returned array than its descendants.
 *
 * Returns Array<{
 *   robloxPath:          string[],   — full Roblox instance path from the tree root
 *   fsPath:              string,     — raw $path value from project.json
 *   normalisedFsPath:    string,     — normaliseFsPath() applied to fsPath
 *   absoluteFsPath:      string,     — resolved absolute filesystem path
 *   hasNodeModulesChild: boolean,    — true if this node has a "node_modules" child key
 * }>
 */
function traverseProjectTree(node, currentRobloxPath = []) {
    const results = [];

    if (typeof node !== 'object' || node === null) return results;

    for (const [key, value] of Object.entries(node)) {
        if (key.startsWith('$')) continue;
        if (typeof value !== 'object' || value === null) continue;

        const childRobloxPath = [...currentRobloxPath, key];

        if ('$path' in value) {
            const fsPath = value['$path'];
            results.push({
                robloxPath: childRobloxPath,
                fsPath,
                normalisedFsPath: normaliseFsPath(fsPath),
                absoluteFsPath: path.resolve(CWD, fsPath),
                hasNodeModulesChild: 'node_modules' in value,
            });
        }

        results.push(...traverseProjectTree(value, childRobloxPath));
    }

    return results;
}

/**
 * Returns true if `entry` is the rbxts include folder (the one that contains
 * RuntimeLib and node_modules, NOT an output directory).
 *
 * Primary signal: the project.json node has a "node_modules" child key, which
 * is the convention used by rojo/roblox-ts for the include folder.
 * Fallback: the filesystem directory actually contains RuntimeLib.lua / RuntimeLib.luau.
 */
function isIncludeEntry(entry) {
    if (entry.hasNodeModulesChild) return true;
    return ['RuntimeLib.lua', 'RuntimeLib.luau'].some(name =>
        fs.existsSync(path.join(entry.absoluteFsPath, name))
    );
}

/**
 * Classifies every $path entry in the project.json tree into one of:
 *   serverEntries  — normalisedFsPath exactly equals `${outDir}/server`
 *   clientEntries  — normalisedFsPath exactly equals `${outDir}/client`
 *   sharedEntries  — normalisedFsPath exactly equals `${outDir}/shared`
 *   includeEntry   — the rbxts_include folder that contains RuntimeLib
 *
 * Classification requires an exact match against the full outDir-prefixed path
 * derived from tsconfig.json.  Matching only the terminal segment (e.g. "server")
 * would produce false positives for any unrelated directory that happens to share
 * that name.  The Roblox service the directory is parented under is irrelevant
 * and is not used as a classification signal at all.
 *
 * Also derives the runtimeLibRobloxPath used by the require() interceptor.
 */
function analyzeProjectJson(projectJson, outDir) {
    const allEntries = traverseProjectTree(projectJson.tree);

    const serverEntries = [];
    const clientEntries = [];
    const sharedEntries = [];
    let includeEntry = null;

    const expectedServer = `${outDir}/server`;
    const expectedClient = `${outDir}/client`;
    const expectedShared = `${outDir}/shared`;

    for (const entry of allEntries) {
        if (isIncludeEntry(entry)) {
            if (includeEntry === null) includeEntry = entry;
            continue;
        }

        if (includeEntry !== null) {
            const includeDepth = includeEntry.robloxPath.length;
            const isDescendantOfInclude =
                entry.robloxPath.length > includeDepth &&
                includeEntry.robloxPath.every((seg, i) => entry.robloxPath[i] === seg);

            if (isDescendantOfInclude) continue;
        }

        const p = entry.normalisedFsPath;

        if (p === expectedServer) {
            serverEntries.push(entry);
        } else if (p === expectedClient) {
            clientEntries.push(entry);
        } else if (p === expectedShared) {
            sharedEntries.push(entry);
        }
    }

    if (includeEntry === null) {
        throw new Error(
            '[bundle] Could not locate the rbxts_include folder in default.project.json. ' +
            'Ensure the include node has a "node_modules" child key, or that the ' +
            'referenced directory contains RuntimeLib.lua / RuntimeLib.luau.'
        );
    }

    const runtimeLibRobloxPath = [...includeEntry.robloxPath, 'RuntimeLib'];

    return { serverEntries, clientEntries, sharedEntries, includeEntry, runtimeLibRobloxPath };
}

// ── Trie builders ──────────────────────────────────────────────────────────

/**
 * Builds a trie (nested plain object) from the Roblox paths of every output
 * directory entry.  Each leaf in the trie is the sentinel string '__OUTPUT_DIR_MARKER',
 * which is serialised to the Lua-side sentinel table reference of the same name.
 *
 * The trie is used at import-resolution time to determine how many leading path
 * segments to strip from a TS.import call, leaving only the module-relative key
 * used to index into __modulesFolder.
 */
function buildOutputDirTrie(outputEntries) {
    const trie = {};

    for (const entry of outputEntries) {
        let node = trie;
        for (let depth = 0; depth < entry.robloxPath.length; depth++) {
            const seg = entry.robloxPath[depth];

            if (depth === entry.robloxPath.length - 1) {
                node[seg] = '__OUTPUT_DIR_MARKER';
            } else {
                if (!node[seg] || node[seg] === '__OUTPUT_DIR_MARKER') {
                    node[seg] = {};
                }
                node = node[seg];
            }
        }
    }

    return trie;
}

/**
 * Serialises a trie built by `buildOutputDirTrie` into a Lua table constructor
 * string.  Leaves are emitted as references to the `__OUTPUT_DIR_MARKER` sentinel.
 * The returned string does NOT include the outer `{}`; the caller wraps it.
 */
function serializeTrieToLua(node, depth) {
    const indent = '\t'.repeat(depth);
    const lines = [];

    for (const [key, value] of Object.entries(node)) {
        if (value === '__OUTPUT_DIR_MARKER') {
            lines.push(`${indent}["${escLua(key)}"] = __OUTPUT_DIR_MARKER`);
        } else {
            const inner = serializeTrieToLua(value, depth + 1);
            if (inner.length > 0) {
                lines.push(`${indent}["${escLua(key)}"] = {\n${inner}\n${indent}}`);
            } else {
                lines.push(`${indent}["${escLua(key)}"] = {}`);
            }
        }
    }

    return lines.join(',\n');
}

// ── File collection ────────────────────────────────────────────────────────

/**
 * Recursively collect .luau files under `dir`.
 * `baseSegs` is the path segment array from the root being scanned.
 *
 * Returns { modules, standalones } where:
 *   modules     — { filePath, segments }                    (no .client/.server suffix)
 *   standalones — { filePath, segments, scriptType }        (.client or .server)
 *
 * `segments` are relative to the output directory root (baseSegs = []).
 * They are used as keys into __modulesFolder and do NOT include any Roblox
 * service or folder prefix — the trie in the preamble handles that mapping.
 */
function collectLuauFiles(dir, baseSegs = []) {
    const modules = [];
    const standalones = [];
    if (!fs.existsSync(dir)) return { modules, standalones };

    for (const entry of fs.readdirSync(dir).sort()) {
        const fullPath = path.join(dir, entry);
        const stat = fs.statSync(fullPath);

        if (stat.isDirectory()) {
            const sub = collectLuauFiles(fullPath, [...baseSegs, entry]);
            modules.push(...sub.modules);
            standalones.push(...sub.standalones);
        } else if (entry.endsWith('.luau')) {
            const nameNoExt = entry.slice(0, -5);

            if (nameNoExt.endsWith('.client') || nameNoExt.endsWith('.server')) {
                const scriptType = nameNoExt.endsWith('.client') ? 'client' : 'server';
                const instanceName = nameNoExt.replace(/\.(client|server)$/, '');
                standalones.push({
                    filePath: fullPath,
                    segments: [...baseSegs, instanceName],
                    scriptType,
                });
            } else {
                modules.push({
                    filePath: fullPath,
                    segments: [...baseSegs, nameNoExt],
                });
            }
        }
    }

    return { modules, standalones };
}

// ── Lua table initialisation ───────────────────────────────────────────────

/**
 * Emit `__modulesFolder[...] = __modulesFolder[...] or {}` lines for every
 * intermediate table that must exist before leaf function assignments.
 * Sorted by depth so parents are always initialised before children.
 */
function buildTableInits(moduleFiles) {
    const seen = new Set();
    const toInit = [];

    for (const { segments } of moduleFiles) {
        for (let depth = 1; depth < segments.length; depth++) {
            const parentSegs = segments.slice(0, depth);
            const key = parentSegs.join('\x00');

            if (!seen.has(key)) {
                seen.add(key);
                toInit.push(parentSegs);
            }
        }
    }

    toInit.sort((a, b) => a.length - b.length);

    return toInit
        .map(segs => {
            const bracketPath = segs.map(s => `["${escLua(s)}"]`).join('');
            return `__modulesFolder${bracketPath} = __modulesFolder${bracketPath} or {}`;
        })
        .join('\n');
}

// ── Wrapper generators ─────────────────────────────────────────────────────

/**
 * Wraps a compiled module file in a factory function stored on __modulesFolder.
 *
 * `local __modulesFolder = nil` is inserted at the top of the function body so
 * that module code cannot directly read or write the global module registry —
 * all cross-module access must go through TS.import, which closes over the
 * top-level __modulesFolder from the preamble scope.
 */
function generateModuleWrapper({ filePath, segments }) {
    const raw = fs.readFileSync(filePath, 'utf8');
    const segsLua = segments.map(s => `"${escLua(s)}"`).join(', ');
    const bracketPath = segments.map(s => `["${escLua(s)}"]`).join('');

    const prologueLua =
        `\tlocal __modulesFolder = nil\n` +
        `\tlocal __customTS = nil\n` +
        `\tlocal getRobloxInstancePath = nil\n` +
        `\tlocal matchesRuntimeLibPath = nil\n` +
        `\tlocal resolveModuleRelativeSegs = nil\n` +
        `\tlocal __robloxTree = nil\n` +
        `\tlocal __OUTPUT_DIR_MAKER = nil\n` +
        `\tlocal __runtimeLibPath = nil\n` +
        `\tlocal __modulesCachedValues = nil\n` +
        `\tlocal old_require = nil\n` +
        `\tlocal newFakeInstance = nil\n` +
        `\tlocal old_game = nil\n` +
        `\tlocal script\n` +
        `\tscript = newFakeInstance({${segsLua}})`;

    return (
        `__modulesFolder${bracketPath} = function()\n` +
        `${prologueLua}\n` +
        `${indentLines(raw, '\t')}\n` +
        `end`
    );
}

/**
 * Wraps a compiled standalone script (.client.luau / .server.luau) in a
 * `task.defer` call so it executes after the module registry is fully populated.
 *
 * Same `local __modulesFolder = nil` isolation as module wrappers.
 */
function generateStandaloneWrapper({ filePath, segments }) {
    const raw = fs.readFileSync(filePath, 'utf8');
    const segsLua = segments.map(s => `"${escLua(s)}"`).join(', ');

    const prologueLua =
        `\tlocal __modulesFolder = nil\n` +
        `\tlocal script\n` +
        `\tscript = newFakeInstance({${segsLua}})`;

    return (
        `task.defer(function()\n` +
        `${prologueLua}\n` +
        `${indentLines(raw, '\t')}\n` +
        `end)`
    );
}

// ── Preamble ───────────────────────────────────────────────────────────────

/**
 * Generates the Lua preamble that is prepended to every bundle.
 *
 * @param {string}   runtimeLibPathLua  Comma-separated Lua string literals for
 *                                      the RuntimeLib's Roblox instance path.
 * @param {string}   robloxTreeLua      Lua table constructor for the output-dir
 *                                      trie (produced by serializeTrieToLua).
 */
function generatePreamble(runtimeLibPathLua, robloxTreeLua) {
    return `\
-- bundled with deadline-ts (no rbxts modules supported yet)
function assert(condition, messageIfFalse)
\tif not condition then error(messageIfFalse or _VERSION .. " assertion error") end
end
local _VERSION = _VERSION.." {deadline-ts PRE-RELEASE}"
local unpack = table.unpack
local old_require = require
local __modulesFolder = {}
local __modulesCachedValues = {}

-- Roblox instance path of the RuntimeLib module. The custom require() wrapper
-- intercepts any require() call whose target resolves to this path and returns
-- __customTS instead, making the bundle self-contained in both Roblox and
-- Deadline-TS environments.
local __runtimeLibPath = {${runtimeLibPathLua}}

-- Trie mirroring the Roblox tree for all compiled output directories.
-- TS.import walks this trie against the incoming path segments to find the
-- output directory boundary; segments after that boundary are the module-relative
-- key used to index __modulesFolder.
local __OUTPUT_DIR_MARKER = {}
local __robloxTree = {
${robloxTreeLua}
}

-- Constructs a lightweight fake Roblox Instance backed by a path-segment array.
-- Used when running outside a real Roblox environment (Deadline-TS).
local function newFakeInstance(pathSegs)
\tpathSegs = pathSegs or {}
\tlocal inst = {}
\tinst.__path = pathSegs
\tinst.Name = pathSegs[#pathSegs] or ""
\tinst.WaitForChild = function(self, name)
\t\tlocal newPath = {}
\t\tfor i = 1, #pathSegs do newPath[i] = pathSegs[i] end
\t\tnewPath[#newPath + 1] = name
\t\treturn newFakeInstance(newPath)
\tend
\tif #pathSegs > 1 then
\t\tlocal parentSegs = {}
\t\tfor i = 1, #pathSegs - 1 do parentSegs[i] = pathSegs[i] end
\t\tinst.Parent = newFakeInstance(parentSegs)
\telse
\t\tinst.Parent = {
\t\t\t__path = {},
\t\t\tName = "",
\t\t\tWaitForChild = function(self, name) return newFakeInstance({name}) end,
\t\t\tis_fake_instance = true,
\t\t}
\t\tinst.is_fake_instance = true
\tend
\treturn inst
end

-- Use the real Roblox game global when available; fall back to a minimal fake
-- that covers GetService so compiled imports resolve to fake instances.
local old_game = game
local game
if old_game ~= nil then
\tgame = old_game
else
\tgame = {
\t\tGetService = function(self, name)
\t\t\tlocal inst = newFakeInstance({name})
\t\t\tinst.__isService = true
\t\t\treturn inst
\t\tend,
\t}
end

-- Walks the Parent chain of a real Roblox Instance to reconstruct its path
-- segment array. Only reached when running inside a real Roblox environment.
local function getRobloxInstancePath(inst)
\tlocal parts = {}
\tlocal current = inst
\twhile current ~= nil and current.Parent ~= nil do
\t\ttable.insert(parts, 1, current.Name)
\t\tcurrent = current.Parent
\tend
\treturn parts
end

-- Returns true when the given segment array exactly matches __runtimeLibPath.
local function matchesRuntimeLibPath(pathToCheck)
\tif #pathToCheck ~= #__runtimeLibPath then return false end
\tfor i = 1, #__runtimeLibPath do
\t\tif pathToCheck[i] ~= __runtimeLibPath[i] then return false end
\tend
\treturn true
end

-- Uses the __robloxTree trie to determine which leading segments of an import
-- call belong to the output directory path, then returns only the remaining
-- module-relative segments for __modulesFolder lookup.
--
-- Works for both fake instances (table with .Name) and real Roblox Instances
-- (userdata with .Name), since both expose a Name field on startModule.
local function resolveModuleRelativeSegs(startModule, ...)
\tlocal varargs = table.pack(...)
\tlocal segCount = varargs.n
\tlocal serviceName = startModule.Name
\tlocal serviceNode = __robloxTree[serviceName]

\tif serviceNode == nil then
\t\t-- Unknown service: return all segments unchanged (import will error on lookup
\t\t-- if the module is not registered, which is the correct failure mode).
\t\tlocal segs = {}
\t\tfor i = 1, segCount do segs[i] = varargs[i] end
\t\treturn segs
\tend

\tlocal currentNode = serviceNode

\tfor i = 1, segCount do
\t\tlocal seg = varargs[i]
\t\tlocal nextNode = currentNode[seg]

\t\tif nextNode == nil then
\t\t\t-- Current segment is not part of the output directory prefix.
\t\t\t-- Collect from here onwards as the module-relative path.
\t\t\tlocal relSegs = {}
\t\t\tfor j = i, segCount do relSegs[#relSegs + 1] = varargs[j] end
\t\t\treturn relSegs
\t\tend

\t\tif nextNode == __OUTPUT_DIR_MARKER then
\t\t\t-- Output directory boundary reached; collect everything after as the
\t\t\t-- module-relative path.
\t\t\tlocal relSegs = {}
\t\t\tfor j = i + 1, segCount do relSegs[#relSegs + 1] = varargs[j] end
\t\t\treturn relSegs
\t\tend

\t\tcurrentNode = nextNode
\tend

\t-- Exhausted all segments while still inside the trie (should not occur in
\t-- well-formed roblox-ts output).
\treturn {}
end

-- Self-contained RuntimeLib replacement. Returned to any compiled roblox-ts code
-- that requires RuntimeLib. Provides TS.import and all pure-Lua TS runtime
-- utilities. RunService-dependent features (isPlugin, getModule) are omitted
-- as they are unnecessary in a bundled, self-contained context.
local __customTS = {}

-- Promise is not bundled. TS.async / TS.await will error if called without a
-- Promise implementation being assigned to __customTS.Promise externally.
__customTS.Promise = nil

__customTS.import = function(context, startModule, ...)
\tlocal relSegs = resolveModuleRelativeSegs(startModule, ...)

\tif #relSegs == 0 then
\t\terror('TS.import: resolved to an empty module path — check your project.json output directory configuration')
\tend

\tlocal cacheKey = table.concat(relSegs, '\\0')

\tif __modulesCachedValues[cacheKey] ~= nil then
\t\treturn __modulesCachedValues[cacheKey]
\tend

\tlocal node = __modulesFolder
\tfor _, seg in ipairs(relSegs) do
\t\tnode = node[seg]
\t\tif node == nil then
\t\t\terror('TS.import: module not found at path "' .. table.concat(relSegs, '/') .. '"')
\t\tend
\tend

\tif type(node) ~= 'function' then
\t\terror('TS.import: resolved path "' .. table.concat(relSegs, '/') .. '" is not a module factory')
\tend

\tlocal result = node()
\t__modulesCachedValues[cacheKey] = result
\treturn result
end

__customTS.instanceof = function(obj, class)
\tif type(class) == 'table' and type(class.instanceof) == 'function' then
\t\treturn class.instanceof(obj)
\tend
\tif type(obj) == 'table' then
\t\tobj = getmetatable(obj)
\t\twhile obj ~= nil do
\t\t\tif obj == class then return true end
\t\t\tlocal mt = getmetatable(obj)
\t\t\tif mt then
\t\t\t\tobj = mt.__index
\t\t\telse
\t\t\t\tobj = nil
\t\t\tend
\t\tend
\tend
\treturn false
end

__customTS.async = function(callback)
\treturn function(...)
\t\tlocal n = select('#', ...)
\t\tlocal args = {...}
\t\treturn __customTS.Promise.new(function(resolve, reject)
\t\t\tlocal ok, result = pcall(callback, unpack(args, 1, n))
\t\t\tif ok then
\t\t\t\tresolve(result)
\t\t\telse
\t\t\t\treject(result)
\t\t\tend
\t\tend)
\tend
end

__customTS.await = function(promise)
\tif not __customTS.Promise or not __customTS.Promise.is(promise) then
\t\treturn promise
\tend
\tlocal status, value = promise:awaitStatus()
\tif status == __customTS.Promise.Status.Resolved then
\t\treturn value
\telseif status == __customTS.Promise.Status.Rejected then
\t\terror(value, 2)
\telse
\t\terror('The awaited Promise was cancelled', 2)
\tend
end

local __SIGN = 2 ^ 31
local __COMPLEMENT = 2 ^ 32
local function __bitSign(num)
\tif bit32.btest(num, __SIGN) then
\t\treturn num - __COMPLEMENT
\telse
\t\treturn num
\tend
end

__customTS.bit_lrsh = function(a, b)
\treturn __bitSign(bit32.arshift(a, b))
end

__customTS.TRY_RETURN = 1
__customTS.TRY_BREAK = 2
__customTS.TRY_CONTINUE = 3

__customTS.try = function(try, catch, finally)
\tlocal trySuccess, exitTypeOrTryError, returns = pcall(try)
\tlocal exitType, tryError
\tif trySuccess then
\t\texitType = exitTypeOrTryError
\telse
\t\ttryError = exitTypeOrTryError
\tend
\tlocal catchSuccess = true
\tlocal catchError
\tif not trySuccess and catch then
\t\tlocal newExitType, newReturns
\t\tcatchSuccess, newExitType, newReturns = pcall(catch, tryError)
\t\tlocal resolvedExitType
\t\tif catchSuccess then
\t\t\tresolvedExitType = newExitType
\t\telse
\t\t\tcatchError = newExitType
\t\tend
\t\tif resolvedExitType then
\t\t\texitType, returns = resolvedExitType, newReturns
\t\tend
\tend
\tif finally then
\t\tlocal finallyExitType, finallyReturns = finally()
\t\tif finallyExitType then
\t\t\texitType, returns = finallyExitType, finallyReturns
\t\tend
\tend
\tif exitType ~= __customTS.TRY_RETURN and exitType ~= __customTS.TRY_BREAK and exitType ~= __customTS.TRY_CONTINUE then
\t\tif not catchSuccess then
\t\t\terror(catchError, 2)
\t\tend
\t\tif not trySuccess and not catch then
\t\t\terror(tryError, 2)
\t\tend
\tend
\treturn exitType, returns
end

__customTS.generator = function(callback)
\tlocal co = coroutine.create(callback)
\treturn {
\t\tnext = function(...)
\t\t\tif coroutine.status(co) == 'dead' then
\t\t\t\treturn {done = true}
\t\t\tend
\t\t\tlocal success, value = coroutine.resume(co, ...)
\t\t\tif success == false then
\t\t\t\terror(value, 2)
\t\t\tend
\t\t\treturn {
\t\t\t\tvalue = value,
\t\t\t\tdone = coroutine.status(co) == 'dead',
\t\t\t}
\t\tend,
\t}
end

-- Smart require() wrapper.
--
-- Intercepts require() calls targeting the RuntimeLib instance (resolved via
-- __runtimeLibPath) and returns __customTS so the bundle is self-contained.
-- All other require() calls are forwarded to old_require unchanged, preserving
-- full compatibility with anything else in the environment (numbers, real
-- ModuleScripts outside the intercepted path, etc.).
local require = function(moduleRef)
\tif type(moduleRef) == 'table' and moduleRef.__path then
\t\tif matchesRuntimeLibPath(moduleRef.__path) then
\t\t\treturn __customTS
\t\tend
\tend
\tif type(moduleRef) == 'userdata' then
\t\tlocal instPath = getRobloxInstancePath(moduleRef)
\t\tif matchesRuntimeLibPath(instPath) then
\t\t\treturn __customTS
\t\tend
\tend
\treturn old_require(moduleRef)
end
`;
}

// ── Main ───────────────────────────────────────────────────────────────────
//   "scripts": {
//     "build": "rbxtsc",
//     "watch": "rbxtsc -w"
//   },
console.log('[bundle] Running dog builder…');
// execSync('npm run build', { cwd: CWD, stdio: 'inherit' });
execSync(readDogBuildConfigScripts(), { cwd: CWD, stdio: 'inherit' });
console.log('[bundle] Build complete.\n');

const outDir = readTsConfigOutDir();
console.log(`[bundle] tsconfig outDir: "${outDir}"`);

const projectJson = readProjectJson();
const {
    serverEntries,
    clientEntries,
    sharedEntries,
    runtimeLibRobloxPath,
} = analyzeProjectJson(projectJson, outDir);

console.log(`[bundle] Detected ${serverEntries.length} server output dir(s), ` +
    `${clientEntries.length} client output dir(s), ` +
    `${sharedEntries.length} shared output dir(s).`);

const allOutputEntries = [...serverEntries, ...clientEntries, ...sharedEntries];
const robloxTreeTrie = buildOutputDirTrie(allOutputEntries);
const robloxTreeLua = serializeTrieToLua(robloxTreeTrie, 1);
const runtimeLibPathLua = runtimeLibRobloxPath.map(s => `"${escLua(s)}"`).join(', ');

const preamble = generatePreamble(runtimeLibPathLua, robloxTreeLua);

fs.mkdirSync(DIST_DIR, { recursive: true });
fs.mkdirSync(DEADLINEOUT_DIR, { recursive: true });

for (const [bundleType, primaryEntries] of [['server', serverEntries], ['client', clientEntries]]) {
    console.log(`[bundle] Processing ${bundleType}…`);

    const parts = [preamble.trimEnd()];

    let allModules = [];
    let allStandalones = [];

    // Shared modules are included in every bundle since both client and server
    // scripts can import from ReplicatedStorage.
    for (const sharedEntry of sharedEntries) {
        const collected = collectLuauFiles(sharedEntry.absoluteFsPath);
        allModules.push(...collected.modules);
        allStandalones.push(...collected.standalones);
    }

    // Primary (server or client) modules and standalone scripts.
    for (const primaryEntry of primaryEntries) {
        const collected = collectLuauFiles(primaryEntry.absoluteFsPath);
        allModules.push(...collected.modules);
        allStandalones.push(...collected.standalones);
    }

    const tableInits = buildTableInits(allModules);
    if (tableInits) parts.push(tableInits);

    for (const mod of allModules) {
        parts.push(generateModuleWrapper(mod));
    }

    for (const standalone of allStandalones) {
        parts.push(generateStandaloneWrapper(standalone));
    }

    const output = parts.join('\n\n') + '\n';
    const outPath = path.join(DIST_DIR, `${bundleType}.luau`);
    fs.writeFileSync(outPath, output, 'utf8');
    console.log(`[bundle] Written → ${outPath}`);

    const deadlineOutPath = path.join(DEADLINEOUT_DIR, `${bundleType}.luau`);
    console.log(`[bundle] Running darklua on ${bundleType}…`);
    execSync(`darklua process "${outPath}" "${deadlineOutPath}"`, { cwd: CWD, stdio: 'inherit' });
    console.log(`[bundle] darklua → ${deadlineOutPath}`);
}

console.log('\n[bundle] Done.');
