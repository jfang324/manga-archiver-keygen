"use strict";

const parser = require("@babel/parser");
const traverse = require("@babel/traverse").default;
const generate = require("@babel/generator").default;
const t = require("@babel/types");

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

module.exports = { extractMaskBlocks };
