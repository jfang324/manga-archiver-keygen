"use strict";

const parser = require("@babel/parser");
const traverse = require("@babel/traverse").default;
const generate = require("@babel/generator").default;
const t = require("@babel/types");
const crypto = require("crypto");
const vm = require("vm");

const BUNDLE_PARSE_OPTIONS = {
  sourceType: "unambiguous",
  plugins: [
    "jsx",
    "classProperties",
    "optionalChaining",
    "nullishCoalescingOperator",
    "topLevelAwait",
  ],
};

const RESULT_MARKER = "__manga_archiver_keygen_result__";

function isDecoderCall(node) {
  return t.isCallExpression(node) && t.isIdentifier(node.callee);
}

function isCandidateElement(node) {
  return (
    t.isBinaryExpression(node, { operator: "+" }) &&
    isDecoderCall(node.left) &&
    isDecoderCall(node.right)
  );
}

// The mask array is defined in the same `var/const` declaration that carries
// the build id check: `...!=="string"?"96":"",Cd=[Bn(-387)+Bn(-433),...]`.
// Accept any 4-element array that isn't entirely string/object/regex literals
// (the mask elements are decoder-call sums like the rest of the chunk's
// rotated tables).
function findRootArray(programBody) {
  for (const node of programBody) {
    if (!t.isVariableDeclaration(node) || node.kind !== "const") continue;
    for (const decl of node.declarations) {
      if (!t.isIdentifier(decl.id) || !t.isArrayExpression(decl.init)) continue;
      const elements = decl.init.elements;
      if (elements.length !== 4) continue;
      if (elements.every((e) => t.isStringLiteral(e))) continue;
      if (elements.every((e) => t.isObjectExpression(e))) continue;
      if (elements.every((e) => t.isRegExpLiteral(e))) continue;
      return decl.id.name;
    }
  }
  return null;
}

// The table function is a function whose body is a variable declaration
// initialised to an array literal (the string table the decoders read from).
function isTableFunction(node) {
  if (!t.isFunctionDeclaration(node) || !node.id) return false;
  const body = node.body.body;
  if (body.length !== 2 || !t.isVariableDeclaration(body[0])) return false;
  const decl = body[0].declarations[0];
  return Boolean(
    decl && t.isIdentifier(decl.id) && t.isArrayExpression(decl.init)
  );
}

function parseBundle(source) {
  return parser.parse(source, BUNDLE_PARSE_OPTIONS);
}

function propertyName(key) {
  if (t.isIdentifier(key)) return key.name;
  if (t.isStringLiteral(key) || t.isNumericLiteral(key)) {
    return String(key.value);
  }
  return null;
}

function sandboxLogs(source, timeout = 20000) {
  const logs = [];
  const ctx = vm.createContext({
    Buffer,
    TextEncoder,
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
    btoa: (s) => Buffer.from(s, "binary").toString("base64"),
    console: {
      ...console,
      log: (...args) => logs.push(args),
    },
  });
  vm.runInContext(source, ctx, { timeout });
  return logs;
}

// Evaluate a small expression against only the top-level declarations it
// references. This keeps decoder/table dependencies available without running
// route or browser code from the rest of a module.
function createBundleEvaluator(source) {
  const ast = parseBundle(source);
  const programBody = ast.program.body;
  const declarations = new Map();

  for (const node of programBody) {
    if (t.isFunctionDeclaration(node) && node.id) {
      declarations.set(node.id.name, node);
    }
    if (t.isVariableDeclaration(node)) {
      for (const decl of node.declarations) {
        if (t.isIdentifier(decl.id)) declarations.set(decl.id.name, node);
      }
    }
  }

  function collect(name, visited) {
    if (visited.has(name)) return;
    const node = declarations.get(name);
    if (!node) return;
    visited.add(name);
    traverse(node, {
      noScope: true,
      Identifier(path) {
        const id = path.node.name;
        if (id === name || !declarations.has(id)) return;
        collect(id, visited);
      },
    });
  }

  function evaluate(expression, rootNames = []) {
    const visited = new Set();
    for (const name of rootNames) collect(name, visited);

    const tableEnabledStatements = [];
    for (const name of visited) {
      const node = declarations.get(name);
      if (!isTableFunction(node)) continue;
      tableEnabledStatements.push(...findUsers(node.id.name, programBody));
    }

    const output = [];
    const emitted = new Set();
    for (const node of programBody) {
      const shouldEmit =
        tableEnabledStatements.includes(node) ||
        (t.isFunctionDeclaration(node) && visited.has(node?.id?.name)) ||
        (t.isVariableDeclaration(node) &&
          node.declarations.some((d) => t.isIdentifier(d.id) && visited.has(d.id.name)));
      if (!shouldEmit || emitted.has(node)) continue;
      emitted.add(node);
      output.push(generate(node).code);
    }
    output.push(
      `console.log(${JSON.stringify(RESULT_MARKER)}, (${expression}));`
    );

    const hits = sandboxLogs(output.join("\n\n")).filter(
      (args) => args.length === 2 && args[0] === RESULT_MARKER
    );
    if (!hits.length) throw new Error("Dependency slice did not produce a result");
    return hits[hits.length - 1][1];
  }

  function expressionRoots(expression) {
    const roots = new Set();
    const traversalRoot = t.isExpression(expression)
      ? t.expressionStatement(expression)
      : expression;
    traverse(traversalRoot, {
      noScope: true,
      Identifier(path) {
        if (declarations.has(path.node.name)) roots.add(path.node.name);
      },
    });
    return [...roots];
  }

  return { ast, programBody, declarations, evaluate, expressionRoots };
}

// Find the statements (typically IIFEs) that reference a given top-level name;
// the rotation IIFEs read the string table and must run before decoding.
function findUsers(name, programBody) {
  const users = [];
  for (const stmt of programBody) {
    traverse(stmt, {
      noScope: true,
      Identifier(path) {
        if (path.node.name !== name) return;
        if (
          path.parentPath == null ||
          path.parentPath.isFunctionDeclaration({ id: path.node }) ||
          path.parentPath.isVariableDeclarator({ id: path.node }) ||
          stmt.type === "ExportNamedDeclaration"
        ) {
          return;
        }
        const fn = path.getFunctionParent();
        if (fn) users.push(fn.node);
        if (!users.includes(stmt)) users.push(stmt);
        path.stop();
      },
    });
  }
  return users;
}

// Extract the mask blocks (array of base64 strings) from a bundle chunk.
//
// The chunk defines an obfuscated top-level array whose decoder calls resolve
// to the mask blocks. We isolate that declaration and its dependents and read
// the evaluated array back from a limited VM.
function extractMaskBlocks(source) {
  const evaluator = createBundleEvaluator(source);
  const rootName = findRootArray(evaluator.programBody);
  if (!rootName) throw new Error("Couldn't find a suitable root array");

  const blocks = evaluator.evaluate(rootName, [rootName]);
  if (!Array.isArray(blocks) || blocks.length !== 4) {
    throw new Error("Expected 4 mask blocks, got: " + JSON.stringify(blocks));
  }
  return blocks;
}

function literalBuildId(value) {
  if (t.isStringLiteral(value)) return value.value;
  if (t.isNumericLiteral(value)) return String(value.value);
  return null;
}

// Resolve every x-build-id header anchor and require them to agree. Current
// chunks hide the value behind decoder calls, while older chunks expose it as
// a literal in the typeof fallback; support both forms.
function extractBuildId(source) {
  const evaluator = createBundleEvaluator(source);
  const candidates = [];

  traverse(evaluator.ast, {
    ObjectProperty(path) {
      if (propertyName(path.node.key)?.toLowerCase() !== "x-build-id") return;
      const literal = literalBuildId(path.node.value);
      if (literal != null) {
        candidates.push({ label: "x-build-id literal", value: literal });
        return;
      }
      candidates.push({
        label: `x-build-id ${generate(path.node.value).code}`,
        expression: generate(path.node.value).code,
        roots: evaluator.expressionRoots(path.node.value),
      });
    },
  });

  const legacy = source.match(/!=="string"\?"([0-9]+)"/);
  if (legacy) candidates.push({ label: "legacy typeof fallback", value: legacy[1] });

  const values = [];
  const failures = [];
  for (const candidate of candidates) {
    try {
      const value =
        candidate.value != null
          ? candidate.value
          : evaluator.evaluate(candidate.expression, candidate.roots);
      if (/^[0-9]+$/.test(String(value))) values.push(String(value));
    } catch (error) {
      failures.push(`${candidate.label}: ${error.message}`);
    }
  }

  const unique = [...new Set(values)];
  if (unique.length === 1) return unique[0];
  if (unique.length > 1) {
    throw new Error(`Conflicting build ids extracted: ${unique.join(", ")}`);
  }
  const detail = failures.length ? ` (${failures.join("; ")})` : "";
  throw new Error(`Couldn't extract build id from x-build-id anchors${detail}`);
}

const CRYPTO_CONFIG_KEYS = new Set([
  "saltMul",
  "saltAdd",
  "fragMul",
  "fragAdd",
  "bootPrefix",
  "join",
  "parts",
]);

const CRYPTO_PART_NAMES = new Set(["group", "host", "lane", "buildId", "epoch"]);

function normalizeCryptoConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const config = {
    saltMul: Number(value.saltMul),
    saltAdd: Number(value.saltAdd),
    fragMul: Number(value.fragMul),
    fragAdd: Number(value.fragAdd),
    bootPrefix: value.bootPrefix,
    join: value.join,
    parts: value.parts,
    omitEmptyLane: Boolean(value.omitEmptyLane),
  };
  const numbers = ["saltMul", "saltAdd", "fragMul", "fragAdd"];
  if (!numbers.every((key) => Number.isFinite(config[key]))) return null;
  if (typeof config.bootPrefix !== "string") return null;
  if (typeof config.join !== "string") return null;
  if (!Array.isArray(config.parts)) return null;
  if (!config.parts.every((part) => CRYPTO_PART_NAMES.has(part))) return null;
  return config;
}

// Modern bundles expose an obfuscated config object that controls the mask
// keystream and HMAC signing inputs. Older bundles do not have this object and
// use the legacy derivation retained in keygen.js.
function extractCryptoConfig(source) {
  const evaluator = createBundleEvaluator(source);
  const candidateNames = [];

  for (const node of evaluator.programBody) {
    if (!t.isVariableDeclaration(node)) continue;
    for (const decl of node.declarations) {
      if (!t.isIdentifier(decl.id) || !t.isObjectExpression(decl.init)) continue;
      const keys = new Set(
        decl.init.properties
          .filter((prop) => t.isObjectProperty(prop))
          .map((prop) => propertyName(prop.key))
      );
      if ([...CRYPTO_CONFIG_KEYS].every((key) => keys.has(key))) {
        candidateNames.push(decl.id.name);
      }
    }
  }

  if (!candidateNames.length) return null;
  const configs = [];
  for (const name of candidateNames) {
    const config = normalizeCryptoConfig(evaluator.evaluate(name, [name]));
    if (config && !configs.some((other) => JSON.stringify(other) === JSON.stringify(config))) {
      configs.push(config);
    }
  }
  if (configs.length === 1) return configs[0];
  if (configs.length > 1) {
    throw new Error("Conflicting crypto configuration objects extracted");
  }
  throw new Error("Couldn't evaluate crypto configuration object");
}

// Build the sha256 hash the site registers for a GraphQL persisted query. The
// site computes this over the exact query document text (its `rC` is standard
// sha256, confirmed by test vectors).
function queryHash(queryText) {
  return crypto.createHash("sha256").update(queryText).digest("hex");
}

// First template literal in a factory's generated source (the query document
// is the first `return`ed template).
function firstTemplate(src) {
  const m = src.match(/`([\s\S]*?)`/);
  return m ? m[1] : "";
}

// Find the name of the top-level function whose FIRST template literal matches
// `pred`. Query documents are defined as template-literal factories near the
// top of the bundle, e.g. `const YN=function(e,t=!1){return`query...`}`.
function findQueryFactory(programBody, pred) {
  for (const node of programBody) {
    if (t.isFunctionDeclaration(node) && node.id) {
      const src = generate(node).code;
      if (src.includes("`") && pred(firstTemplate(src))) return node.id.name;
    }
    if (t.isVariableDeclaration(node)) {
      for (const decl of node.declarations) {
        if (!t.isIdentifier(decl.id)) continue;
        const src = generate(decl.init || node).code;
        if (src.includes("`") && pred(firstTemplate(src))) return decl.id.name;
      }
    }
  }
  return null;
}

// Extract the three GraphQL persisted query documents (search, manga details,
// chapter pages) from a bundle chunk and return their sha256 hashes.
//
// Each document is defined as a function returning a template literal (with
// the search/manga variants selecting a branch via a boolean argument, default
// false). We isolate the minimal dependency slice, evaluate it, call the
// factory with default/false arguments, and hash the resulting document text.
function extractQueryHashes(source) {
  const ast = parser.parse(source, {
    sourceType: "unambiguous",
    plugins: ["jsx", "classProperties", "optionalChaining", "nullishCoalescingOperator", "topLevelAwait"],
  });

  const programBody = ast.program.body;
  const declarations = new Map();
  for (const node of programBody) {
    if (t.isFunctionDeclaration(node) && node.id) {
      declarations.set(node.id.name, node);
    }
    if (t.isVariableDeclaration(node)) {
      for (const decl of node.declarations) {
        if (t.isIdentifier(decl.id)) declarations.set(decl.id.name, node);
      }
    }
  }

  const compact = (s) => s.replace(/\s+/g, " ");
  const markers = {
    search: (s) => compact(s).includes("mangas(") && compact(s).includes("SearchInput"),
    manga: (s) => compact(s).includes("manga( _id: $_id") && compact(s).includes("broadcastInterval"),
    chapter: (s) => compact(s).includes("chapterPages(") && compact(s).includes("$chapterString"),
  };

  const found = {};
  for (const [kind, pred] of Object.entries(markers)) {
    const name = findQueryFactory(programBody, pred);
    if (!name) throw new Error(`Couldn't find query factory for "${kind}"`);
    found[kind] = name;
  }

  const hashes = {};
  for (const [kind, name] of Object.entries(found)) {
    const visited = new Set();
    function collect(ref) {
      if (visited.has(ref)) return;
      const node = declarations.get(ref);
      if (!node) return;
      visited.add(ref);
      traverse(node, {
        noScope: true,
        Identifier(path) {
          const id = path.node.name;
          if (id === ref || !declarations.has(id)) return;
          collect(id);
        },
      });
    }
    collect(name);

    const output = [];
    for (const node of programBody) {
      if (
        (t.isFunctionDeclaration(node) && visited.has(node?.id?.name)) ||
        (t.isVariableDeclaration(node) &&
          node.declarations.some((d) => t.isIdentifier(d.id) && visited.has(d.id.name)))
      ) {
        output.push(generate(node).code);
      }
    }
    output.push(`console.log(${name}(${kind === "chapter" ? "" : "!1, !1"}));`);
    const extractedSource = output.join("\n\n");

    const sandbox = {
      console,
      Buffer,
      TextEncoder,
      atob: (s) => Buffer.from(s, "base64").toString("binary"),
      btoa: (s) => Buffer.from(s, "binary").toString("base64"),
    };
    const logs = [];
    const vm = require("vm");
    const ctx = vm.createContext({
      ...sandbox,
      console: { ...console, log: (...args) => logs.push(...args) },
    });
    vm.runInContext(extractedSource, ctx, { timeout: 20000 });

    const doc = logs.length ? String(logs[0]) : "";
    if (!doc || !doc.includes("query(")) {
      throw new Error(`Resolving query factory "${name}" produced invalid document`);
    }
    hashes[kind] = queryHash(doc);
  }
  return hashes;
}

module.exports = {
  extractBuildId,
  extractCryptoConfig,
  extractMaskBlocks,
  extractQueryHashes,
};
