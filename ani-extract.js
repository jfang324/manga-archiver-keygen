"use strict";

const parser = require("@babel/parser");
const traverse = require("@babel/traverse").default;
const generate = require("@babel/generator").default;
const t = require("@babel/types");
const crypto = require("crypto");

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
        if (fn) {
          users.push(fn.node);
        } else {
          users.push(stmt);
        }
        path.stop();
      },
    });
  }
  return users;
}

// Extract the mask blocks (array of base64 strings) from a bundle chunk.
//
// The chunk defines `const X = [Hr(...) + Hr(...), ...]` where the Hr calls
// read from an obfuscated string table; the resulting values are the base64
// mask blocks. We collect the minimal set of declarations the array depends
// on, evaluate that slice, and read the array back.
function extractMaskBlocks(source) {
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

  const rootName = findRootArray(programBody);
  if (!rootName) throw new Error("Couldn't find a suitable root array");

  const visited = new Set();
  let tableFunction = null;

  function collect(name) {
    if (visited.has(name)) return;
    const node = declarations.get(name);
    if (!node) return;
    visited.add(name);
    if (isTableFunction(node)) tableFunction = node;
    traverse(node, {
      noScope: true,
      Identifier(path) {
        const id = path.node.name;
        if (id === name || !declarations.has(id)) return;
        collect(id);
      },
    });
  }
  collect(rootName);
  if (!tableFunction) throw new Error("Couldn't locate table function");
  const tableUsers = findUsers(tableFunction.id.name, programBody);

  // Emit only the statements the root array depends on (plus the rotation
  // IIFEs that use the string table), then evaluate.
  const output = [];
  for (const node of programBody) {
    if (
      tableUsers.includes(node) ||
      (t.isFunctionDeclaration(node) && visited.has(node?.id?.name)) ||
      (t.isVariableDeclaration(node) &&
        node.declarations.some((d) => t.isIdentifier(d.id) && visited.has(d.id.name)))
    ) {
      output.push(generate(node).code);
    }
  }
  output.push(`console.log(${rootName});`);
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
  vm.runInContext(extractedSource, ctx);

  const blocks = logs.flat();
  if (!Array.isArray(blocks) || blocks.length !== 4) {
    throw new Error("Expected 4 mask blocks, got: " + JSON.stringify(blocks));
  }
  return blocks;
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

module.exports = { extractMaskBlocks, extractQueryHashes };
