import { parseAst } from "vite";

/** Importing startSavedDEApi means a real API subprocess: only classified API tests may do so. */
const sharedApiFixtureImport=/import\s*\{[^}]*\bstartSavedDEApi\b[^}]*\}\s*from\s*['"]\.\/helpers\/d-e-saved-api-fixture\.mjs['"]/u;

const childProcessCallNames = new Set(["spawn", "spawnSync", "exec", "execFile", "execFileSync", "execSync"]);
const childProcessModules = new Set(["node:child_process", "child_process"]);

function staticString(node) {
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral") {
    let value = node.quasis[0].value.cooked;
    if (typeof value !== "string") return;
    for (let index = 0; index < node.expressions.length; index += 1) {
      const expression = staticString(node.expressions[index]), suffix = node.quasis[index + 1].value.cooked;
      if (typeof expression !== "string" || typeof suffix !== "string") return;
      value += expression + suffix;
    }
    return value;
  }
  if (node.type === "BinaryExpression" && node.operator === "+") {
    const left = staticString(node.left), right = staticString(node.right);
    if (typeof left === "string" && typeof right === "string") return left + right;
  }
}

function unwrapCallee(node) {
  while (node.type === "ChainExpression" || node.type === "SequenceExpression") {
    node = node.type === "ChainExpression" ? node.expression : node.expressions.at(-1);
  }
  return node;
}

function calleeName(node) {
  node = unwrapCallee(node);
  if (node.type === "Identifier") return node.name;
  if (node.type === "MemberExpression") return node.computed ? staticString(node.property) : node.property.name;
}

function isModuleLoader(node) {
  node = unwrapCallee(node);
  if (calleeName(node) === "require") return true;
  if (node.type === "MemberExpression" && calleeName(node) === "resolve" &&
      node.object.type === "Identifier" && node.object.name === "require") return true;
  return node.type === "CallExpression" && calleeName(node.callee) === "createRequire";
}

function containsChildProcessOperation(source, file) {
  let ast;
  try { ast = parseAst(source); }
  catch (cause) { throw new Error(`CI_TEST_SOURCE_PARSE_FAILED:${file}`, { cause }); }

  const pending = [ast];
  while (pending.length > 0) {
    const node = pending.pop();
    if (["ImportDeclaration", "ImportExpression", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(node.type) &&
        node.source && childProcessModules.has(staticString(node.source))) return true;
    if (["CallExpression", "NewExpression"].includes(node.type) && (childProcessCallNames.has(calleeName(node.callee)) ||
        isModuleLoader(node.callee) && node.arguments.length > 0 && childProcessModules.has(staticString(node.arguments[0])))) return true;
    // Traverse syntax nodes, including template expressions; literal values are data.
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) if (child && typeof child.type === "string") pending.push(child);
      } else if (value && typeof value.type === "string") pending.push(value);
    }
  }
  return false;
}

const forbiddenPatterns = [
  ["API server entrypoint", /server\.mjs/u],
  ["child process", /node:child_process/u],
  ["network server", /\bcreateServer\s*\(|\.listen\s*\(/u],
  ["network client", /\bfetch\s*\(|\bWebSocket\s*\(|\bXMLHttpRequest\b|node:https?/u],
  ["database client", /\bfrom\s*["']pg["']|\bimport\s*\(\s*["']pg["']\s*\)/u],
  ["live candidate fixture", /candidates\.json/u],
  ["isolated API fixture", sharedApiFixtureImport],
];

/** Offline boundary tests may import HTTP clients only to install fail-fast, zero-call tripwires. */
export function assertOfflineNetworkBoundaryTestSource({ file, source }) {
  for (const [label, pattern] of forbiddenPatterns) {
    if (label === "network client") continue;
    if (pattern.test(source) || label === "child process" && containsChildProcessOperation(source, file)) {
      throw new Error(`CI_TEST_REQUIRES_CLASSIFICATION:${label}:${file}`);
    }
  }
  const fail = reason => { throw new Error(`CI_OFFLINE_NETWORK_BOUNDARY_INVALID:${reason}:${file}`); };
  let ast;
  try { ast = parseAst(source); }
  catch (cause) { throw new Error(`CI_TEST_SOURCE_PARSE_FAILED:${file}`, { cause }); }
  const nodes = [], parents = new Map(), pending = [ast];
  while (pending.length > 0) {
    const node = pending.pop();
    nodes.push(node);
    for (const value of Object.values(node)) {
      const children = Array.isArray(value) ? value : [value];
      for (const child of children) if (child && typeof child.type === "string") {
        parents.set(child, node);
        pending.push(child);
      }
    }
  }
  const ancestor = (node, predicate) => {
    for (let parent = parents.get(node); parent; parent = parents.get(parent)) if (predicate(parent)) return parent;
  };
  const member = (node, name) => node?.type === "MemberExpression" && calleeName(node) === name;
  const clients = new Map(), assertions = new Set(), tests = new Set();
  const networkModule = /^(?:node:)?(?:https?|http2|net|tls|dns(?:\/promises)?|dgram)$|^undici$/u;
  for (const node of nodes) {
    if (["ImportDeclaration", "ImportExpression", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(node.type) && node.source) {
      const name = staticString(node.source);
      if (networkModule.test(name)) {
        if (node.type !== "ImportDeclaration" || !/^node:https?$/u.test(name) || node.specifiers.length !== 1 ||
            !["ImportDefaultSpecifier", "ImportNamespaceSpecifier"].includes(node.specifiers[0].type)) fail("client_import");
        clients.set(node.specifiers[0].local.name, name.slice(5));
      }
      if (node.type === "ImportDeclaration" && ["node:assert/strict", "node:assert", "node:test"].includes(name)) {
        for (const specifier of node.specifiers) if (specifier.type === "ImportDefaultSpecifier") {
          (name === "node:test" ? tests : assertions).add(specifier.local.name);
        }
      }
    }
    if (node.type === "CallExpression" && isModuleLoader(node.callee) && node.arguments.length > 0 &&
        networkModule.test(staticString(node.arguments[0]))) fail("client_import");
  }
  const assertion = (node, method) => node?.type === "CallExpression" && member(node.callee, method) &&
    node.callee.object.type === "Identifier" && assertions.has(node.callee.object.name);
  const tripwires = new Map(), allowedClientReferences = new Set();
  for (const node of nodes) {
    if (node.type !== "CallExpression" || !member(node.callee, "method") || !member(node.callee.object, "mock") ||
        node.callee.object.object.type !== "Identifier" || node.arguments.length !== 3) continue;
    const [target, operation, callback] = node.arguments;
    if (target.type !== "Identifier" || !["ArrowFunctionExpression", "FunctionExpression"].includes(callback.type) ||
        !assertion(callback.body, "fail")) continue;
    const kind = target.name === "globalThis" && staticString(operation) === "fetch" ? "fetch" :
      clients.has(target.name) && staticString(operation) === "request" ? clients.get(target.name) : undefined;
    if (kind) {
      tripwires.set(node, { kind, context: node.callee.object.object.name });
      allowedClientReferences.add(target);
    }
  }
  for (const node of nodes) {
    if (node.type === "Identifier" && clients.has(node.name) &&
        !["ImportDefaultSpecifier", "ImportNamespaceSpecifier"].includes(parents.get(node)?.type) &&
        !allowedClientReferences.has(node)) fail("client_use");
    if (node.type === "Identifier" && ["fetch", "WebSocket", "XMLHttpRequest", "EventSource"].includes(node.name) ||
        node.type === "MemberExpression" && node.object.type === "Identifier" && node.object.name === "globalThis" &&
        (node.computed && staticString(node.property) === undefined || ["fetch", "WebSocket", "XMLHttpRequest", "EventSource"].includes(calleeName(node)))) {
      fail("client_use");
    }
  }
  const guardedHelpers = new Set();
  for (const node of nodes) {
    if (node.type !== "VariableDeclarator" || node.id.type !== "Identifier" || node.init?.type !== "ArrayExpression" ||
        node.init.elements.length !== 3 || !node.init.elements.every(value => tripwires.has(value))) continue;
    const registrations = node.init.elements.map(value => tripwires.get(value));
    const helper = ancestor(node, value => value.type === "FunctionDeclaration");
    if (!helper || helper.params[0]?.type !== "Identifier" || new Set(registrations.map(value => value.kind)).size !== 3 ||
        registrations.some(value => value.context !== helper.params[0].name)) continue;
    const zeroCalls = nodes.some(value => {
      if (!assertion(value, "equal") || value.arguments.length !== 2 || value.arguments[1].type !== "Literal" ||
          value.arguments[1].value !== 0) return false;
      const count = value.arguments[0];
      if (count.type !== "CallExpression" || !member(count.callee, "callCount") || !member(count.callee.object, "mock") ||
          count.callee.object.object.type !== "Identifier") return false;
      const loop = ancestor(value, candidate => candidate.type === "ForOfStatement");
      const after = ancestor(value, candidate => candidate.type === "CallExpression" && member(candidate.callee, "after") &&
        candidate.callee.object.type === "Identifier" && candidate.callee.object.name === helper.params[0].name);
      return loop?.right.type === "Identifier" && loop.right.name === node.id.name &&
        loop.left.type === "VariableDeclaration" && loop.left.declarations[0]?.id.name === count.callee.object.object.name &&
        after && ancestor(after, candidate => candidate.type === "FunctionDeclaration") === helper;
    });
    if (zeroCalls) guardedHelpers.add(helper.id.name);
  }
  const testCalls = nodes.filter(node => node.type === "CallExpression" && node.callee.type === "Identifier" && tests.has(node.callee.name));
  if (guardedHelpers.size === 0 || testCalls.length === 0) fail("tripwire_proof");
  for (const node of testCalls) {
    const callback = node.arguments.at(-1), first = callback?.body?.body?.[0];
    if (!callback || callback.params?.[0]?.type !== "Identifier" || first?.type !== "ExpressionStatement" ||
        first.expression.type !== "CallExpression" || first.expression.callee.type !== "Identifier" ||
        !guardedHelpers.has(first.expression.callee.name) || first.expression.arguments.length !== 1 ||
        first.expression.arguments[0].type !== "Identifier" || first.expression.arguments[0].name !== callback.params[0].name) fail("unguarded_test");
  }
}

/** API tests may use the shared isolated subprocess fixture or the packaged launch script; inspect those implementations too. */
export function assertIsolatedApiTestSource({file,source,sharedFixtureSource,launchScriptSource}) {
  const direct=source.includes('server.mjs');
  const shared=sharedApiFixtureImport.test(source)&&
    /\bstartSavedDEApi\s*\(/u.test(source)&&typeof sharedFixtureSource==='string'&&
    sharedFixtureSource.includes('node:child_process')&&sharedFixtureSource.includes('server.mjs')&&sharedFixtureSource.includes('TEST_REQUIRES_ISOLATED_PORT');
  // Packaged: the test prepares a runtime package in temporary storage and starts it through the package's own launch script,
  // which must exec the bundled Node on server.mjs. The launch script source is inspected, not trusted by name.
  const packaged=/import\s*\{[^}]*\bprepareRuntimePackage\b[^}]*\}\s*from\s*['"]\.\.\/scripts\/runtime-package\.mjs['"]/u.test(source)&&
    /\bprepareRuntimePackage\s*\(/u.test(source)&&source.includes('scripts/launch-server.sh')&&source.includes('node:child_process')&&
    source.includes('TEST_REQUIRES_ISOLATED_PORT')&&typeof launchScriptSource==='string'&&
    /\bexec\s+"\$REVIEW_NODE"\s+"\$REVIEW_RUNTIME_ROOT\/server\.mjs"/u.test(launchScriptSource);
  if(!source.includes('mkdtemp')||!direct&&!shared&&!packaged)throw new Error(`CI_API_TEST_BOUNDARY_MISSING:${file}`);
}

/** Local Seatbelt permits only the runner's three allocated ports. Inspect the named helper, not a comment marker. */
export function assertLocalApiTestPortsSource({ file, source, portFixtureSource, sharedFixtureSource }) {
  const usesAllocated = /import\s*\{[^}]*\ballocatedTestPorts\b[^}]*\}\s*from\s*['"]\.\/helpers\/api-process-lifecycle\.mjs['"]/u.test(source)
    && /\ballocatedTestPorts\s*\(/u.test(source);
  if (usesAllocated) {
    const inspected = typeof portFixtureSource === 'string'
      && portFixtureSource.includes('export function allocatedTestPorts(')
      && ['SELECTION_REVIEW_TEST_PORT', 'SELECTION_REVIEW_TEST_SECOND_PORT', 'SELECTION_REVIEW_TEST_GATEWAY_PORT',
        '65535', 'new Set(ports)', 'TEST_REQUIRES_ISOLATED_PORT'].every(value => portFixtureSource.includes(value));
    const dynamic = /\bfreePort\s*\(|\.listen\s*\(\s*0\b|process\.pid\s*%/u.test(source);
    const shared = !sharedApiFixtureImport.test(source) || typeof sharedFixtureSource === 'string'
      && sharedFixtureSource.includes('const allocated = allocatedTestPorts();')
      && sharedFixtureSource.includes('const dependencyPort = allocated.gateway;')
      && sharedFixtureSource.includes('port !== allocated.api && port !== allocated.second');
    if (!inspected || dynamic || !shared) throw new Error(`LOCAL_API_TEST_PORT_BOUNDARY_MISSING:${file}`);
    return 'allocated_fixture';
  }
  // Previously classified direct/package tests retain their own explicit-port guard and the exact OS whitelist.
  if (!source.includes('SELECTION_REVIEW_TEST_PORT') || !source.includes('TEST_REQUIRES_ISOLATED_PORT')) {
    throw new Error(`LOCAL_API_TEST_PORT_BOUNDARY_MISSING:${file}`);
  }
  return 'direct_guard';
}

export function assertSelfContainedTestSource({
  file,
  source,
  allowTemporaryCandidateFixture = false,
}) {
  for (const [label, pattern] of forbiddenPatterns) {
    if (label === "live candidate fixture" && allowTemporaryCandidateFixture) {
      continue;
    }

    if (pattern.test(source) || label === "child process" && containsChildProcessOperation(source, file)) {
      throw new Error(`CI_TEST_REQUIRES_CLASSIFICATION:${label}:${file}`);
    }
  }
}
